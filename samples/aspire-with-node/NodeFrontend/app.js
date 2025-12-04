// Import instrumentation first - MUST be before any other imports
import { createLogger, recordCacheHit, recordCacheMiss, getCacheStats, getTracer, recordFetchSuccess } from './instrumentation.js';

import { context, trace } from '@opentelemetry/api';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import express from 'express';
import { createClient } from 'redis';

// Read configuration from environment variables
const config = {
    environment: process.env.NODE_ENV || 'development',
    httpPort: process.env['PORT'] ?? 8080,
    httpsPort: process.env['HTTPS_PORT'] ?? 8443,
    httpsRedirectPort: process.env['HTTPS_REDIRECT_PORT'] ?? (process.env['HTTPS_PORT'] ?? 8443),
    httpsRedirectHost: process.env.HOST ?? 'localhost',
    certFile: process.env['HTTPS_CERT_FILE'] ?? '',
    certKeyFile: process.env['HTTPS_CERT_KEY_FILE'] ?? '',
    cacheUri: process.env['CACHE_URI'] ?? '',
    apiServer: process.env['services__weatherapi__https__0'] ?? process.env['services__weatherapi__http__0']
};

// Setup HTTPS options
const httpsOptions = fs.existsSync(config.certFile) && fs.existsSync(config.certKeyFile)
    ? {
        cert: fs.readFileSync(config.certFile),
        key: fs.readFileSync(config.certKeyFile),
        enabled: true
    }
    : { enabled: false };

const startupLogger = createLogger('nodefrontend.startup');
startupLogger.info('Application starting', { httpsEnabled: httpsOptions.enabled });

// Get tracer for creating custom spans
const tracer = getTracer();

// Helper function to fetch forecasts with retry logic
async function fetchForecastsWithRetry(city, maxRetries = 3) {
    const logger = createLogger('nodefrontend.fetchWithRetry');
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        // Create a span for each retry attempt
        const span = tracer.startSpan(`fetch_forecast_attempt_${attempt}`, {
            attributes: {
                'city': city,
                'attempt': attempt,
                'max_retries': maxRetries
            }
        });
        
        try {
            // Execute fetch within the span context so HTTP instrumentation creates nested span
            const result = await context.with(trace.setSpan(context.active(), span), async () => {
                logger.info('Fetching forecasts', { city, attempt, maxRetries });
                span.addEvent('Fetching forecast from API');
                
                // Pass attempt number to backend for retry logic
                const url = `${config.apiServer}/weatherforecast?city=${encodeURIComponent(city)}&attempt=${attempt}`;
                return await fetch(url);
            });
            
            const response = result;
            
            if (!response.ok) {
                const errorText = await response.text();
                span.setAttribute('error', true);
                span.setAttribute('http.status_code', response.status);
                span.addEvent('API returned error', {
                    'http.status_code': response.status,
                    'error.message': errorText
                });
                
                logger.warn('API returned error', { 
                    city,
                    attempt,
                    status: response.status,
                    error: errorText
                });
                
                span.end();
                
                // If this is the last attempt, throw the error
                if (attempt === maxRetries) {
                    throw new Error(`API returned ${response.status}: ${errorText}`);
                }
                
                // Wait before retrying (exponential backoff)
                const delay = Math.pow(2, attempt - 1) * 100; // 100ms, 200ms, 400ms
                logger.info('Retrying after delay', { city, attempt, delay });
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            
            const forecasts = await response.json();
            span.setAttribute('forecast.count', forecasts.length);
            span.addEvent('Successfully fetched forecast', {
                'forecast.count': forecasts.length
            });
            span.end();
            
            logger.info('Successfully fetched forecasts', { city, attempt, count: forecasts.length });
            recordFetchSuccess(city, attempt);
            return forecasts;
            
        } catch (error) {
            span.setAttribute('error', true);
            span.setAttribute('error.type', error.constructor.name);
            span.addEvent('Error fetching forecast', {
                'error.message': error.message
            });
            span.end();
            
            logger.error('Error fetching forecasts', {
                city,
                attempt,
                error: error.message
            });
            
            // If this is the last attempt, throw the error
            if (attempt === maxRetries) {
                throw error;
            }
            
            // Wait before retrying (exponential backoff)
            const delay = Math.pow(2, attempt - 1) * 1000; // 1000ms, 2000ms, 4000ms
            logger.info('Retrying after delay', { city, attempt, delay });
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Setup connection to Redis cache
let cacheConfig = {
    url: config.cacheUri
};
const cache = config.cacheUri ? createClient(cacheConfig) : null;
if (cache) {
    cache.on('error', err => startupLogger.error('Redis Client Error', { error: err }));
    await cache.connect();
    startupLogger.info('Connected to Redis cache');
}

// Setup express app
const app = express();

// Middleware to redirect HTTP to HTTPS
function httpsRedirect(req, res, next) {
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
        // Request is already HTTPS
        return next();
    }
    // Redirect to HTTPS
    const redirectTo = new URL(`https://${config.httpsRedirectHost}:${config.httpsRedirectPort}${req.url}`);
    const logger = createLogger('nodefrontend.httpsRedirect');
    logger.info('Redirecting to HTTPS', { url: redirectTo.toString() });
    res.redirect(redirectTo);
}
if (httpsOptions.enabled) {
    app.use(httpsRedirect);
}

app.get('/', async (req, res) => {
    const logger = createLogger('nodefrontend.getForecastsEndpoint');
    
    // Get city from query parameter, default to Seattle
    const city = req.query.city || 'Seattle';
    const cacheKey = `forecasts:${city}`;
    
    if (cache) {
        const cachedForecasts = await cache.get(cacheKey);
        if (cachedForecasts) {
            logger.info('Cache hit for forecasts', { city });
            recordCacheHit(city); // Record cache hit metric
            res.render('index', { 
                forecasts: JSON.parse(cachedForecasts),
                city: city
            });
            return;
        }
    }

    logger.info('Cache miss - fetching from API', { 
        apiServer: config.apiServer,
        city: city
    });
    recordCacheMiss(city); // Record cache miss metric
    
    try {
        const forecasts = await fetchForecastsWithRetry(city, 3);
        
        if (cache) {
            await cache.set(cacheKey, JSON.stringify(forecasts), { 'EX': 30 }); // Cache for 30 seconds
            logger.info('Forecasts cached for 30 seconds', { city });
        }
        res.render('index', { 
            forecasts: forecasts,
            city: city,
            error: null
        });
    } catch (error) {
        logger.error('Failed to fetch weather data after retries', {
            city,
            error: error.message
        });
        
        res.render('index', { 
            forecasts: [],
            city: city,
            error: `Failed to fetch weather data for ${city}. Please try again later.`
        });
    }
});

// Configure templating
app.set('views', './views');
app.set('view engine', 'pug');

// Health check endpoint
app.get('/health', async (req, res) => {
    const logger = createLogger('nodefrontend.healthEndpoint');
    try {
        const apiServerHealthAddress = `${config.apiServer}/health`;
        logger.info('Health check - fetching API health', { url: apiServerHealthAddress });
        
        const response = await fetch(apiServerHealthAddress);
        if (!response.ok) {
            logger.error('API health check failed', { 
                url: apiServerHealthAddress, 
                status: response.status 
            });
            return res.status(503).send('Unhealthy');
        }
        
        logger.info('Health check passed');
        res.status(200).send('Healthy');
    } catch (error) {
        logger.error('API health check error', { 
            url: `${config.apiServer}/health`, 
            error: error.message 
        });
        res.status(503).send('Unhealthy');
    }
});

// Liveness endpoint
app.get('/alive', (req, res) => {
    const logger = createLogger('nodefrontend.aliveEndpoint');
    logger.info('Liveness check');
    res.status(200).send('Healthy');
});

// Cache statistics endpoint
app.get('/cache-stats', (req, res) => {
    const logger = createLogger('nodefrontend.cacheStatsEndpoint');
    const stats = getCacheStats();
    const total = stats.hits + stats.misses;
    const hitRate = total > 0 ? ((stats.hits / total) * 100).toFixed(2) : 0;
    
    logger.info('Cache statistics requested', stats);
    
    res.json({
        hits: stats.hits,
        misses: stats.misses,
        total: total,
        hitRate: `${hitRate}%`
    });
});

// Start servers
const httpServer = http.createServer(app);
const httpsServer = httpsOptions.enabled ? https.createServer(httpsOptions, app) : null;

httpServer.listen(config.httpPort, () => {
    startupLogger.info('HTTP server started', {
        type: 'HTTP',
        port: config.httpPort,
        address: httpServer.address()
    });
});

if (httpsServer) {
    httpsServer.listen(config.httpsPort, () => {
        startupLogger.info('HTTPS server started', {
            type: 'HTTPS',
            port: config.httpsPort,
            address: httpsServer.address()
        });
    });
}

// Register signal handlers
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Graceful shutdown handler
let isShuttingDown = false;
let cleanupDone = false;

async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    const logger = createLogger('nodefrontend.shutdown');
    logger.info(`Received ${signal}, starting graceful shutdown`);

    // Close servers
    logger.info('Closing servers...');
    const closePromises = [];
    closePromises.push(closeServer(httpServer));
    closePromises.push(closeServer(httpsServer));
    await Promise.all(closePromises);
    logger.info('All servers closed');

    // Cleanup resources
    if (!cleanupDone) {
        cleanupDone = true;
        if (cache) {
            logger.info('Closing Redis connection');
            try {
                await cache.disconnect();
                logger.info('Redis connection closed');
            } catch (error) {
                logger.error('Error closing Redis connection', { error: error.message });
            }
        }
    }

    logger.info('Graceful shutdown complete');
    process.exit(0);

    function closeServer(httpServer) {
        if (!httpServer) return Promise.resolve();
        const serverType = httpServer instanceof https.Server ? 'HTTPS' : 'HTTP'
        logger.info(`Closing ${serverType} server...`);
        return new Promise(resolve => {
            httpServer.close(() => {
                logger.info(`${serverType} server closed`);
                resolve();
            });
            httpServer.closeAllConnections();
        });
    }
}