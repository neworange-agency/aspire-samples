import { env } from 'node:process';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { PeriodicExportingMetricReader, MeterProvider } from '@opentelemetry/sdk-metrics';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { RedisInstrumentation } from '@opentelemetry/instrumentation-redis-4';
import { metrics } from '@opentelemetry/api';
import winston from 'winston';
import { OpenTelemetryTransportV3 } from '@opentelemetry/winston-transport';

const environment = process.env.NODE_ENV || 'development';

// For OpenTelemetry troubleshooting, uncomment the following lines and set the log level to DiagLogLevel.DEBUG
//import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
//diag.setLogger(new DiagConsoleLogger(), environment === 'development' ? DiagLogLevel.DEBUG : DiagLogLevel.WARN);

const otlpServer = env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (otlpServer) {
    console.log(`OTLP endpoint: ${otlpServer}`);

    const sdk = new NodeSDK({
        traceExporter: new OTLPTraceExporter(),
        metricReader: new PeriodicExportingMetricReader({
            exportIntervalMillis: environment === 'development' ? 5000 : 10000,
            exporter: new OTLPMetricExporter(),
        }),
        instrumentations: [
            new HttpInstrumentation(),
            // BUG: The Express instrumentation doesn't currently work for some reason
            new ExpressInstrumentation(),
            new UndiciInstrumentation(),
            new RedisInstrumentation()
        ],
    });

    sdk.start();
}

// Create custom meter for application metrics
const meter = metrics.getMeter('nodefrontend');

// Create custom metrics
export const cacheHitCounter = meter.createCounter('cache.hits', {
    description: 'Number of cache hits',
    unit: 'hits'
});

export const cacheMissCounter = meter.createCounter('cache.misses', {
    description: 'Number of cache misses',
    unit: 'misses'
});

export const cacheHitRateGauge = meter.createObservableGauge('cache.hit_rate', {
    description: 'Cache hit rate as a percentage',
    unit: '%'
});

// Track cache statistics
let cacheStats = {
    hits: 0,
    misses: 0
};

// Register callback for cache hit rate gauge
cacheHitRateGauge.addCallback((observableResult) => {
    const total = cacheStats.hits + cacheStats.misses;
    const hitRate = total > 0 ? (cacheStats.hits / total) * 100 : 0;
    observableResult.observe(hitRate);
});

// Export functions to record cache statistics
export function recordCacheHit(city) {
    cacheStats.hits++;
    cacheHitCounter.add(1, { city });
}

export function recordCacheMiss(city) {
    cacheStats.misses++;
    cacheMissCounter.add(1, { city });
}

export function getCacheStats() {
    return { ...cacheStats };
}

// Setup Winston logger factory with OpenTelemetry transport
export function createLogger(category = 'nodefrontend') {
    return winston.createLogger({
        level: 'info', // This is the min level, anything lower won't be sent
        format: winston.format.json(),
        defaultMeta: { 
            category: category // This doesn't flow to the category in OTLP logs but it's here to ensure it's captured
        },
        transports: [
            new winston.transports.Console({
                format: winston.format.combine(
                    winston.format.colorize(),
                    winston.format.simple()
                )
            }),
            otlpServer ? new OpenTelemetryTransportV3() : null
        ].filter(Boolean)
    });
}