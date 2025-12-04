# Custom Observability Features

This document describes the custom observability features added to the aspire-with-node sample.

## Custom Activity Tracking

The weather API (`AspireWithNode.AspNetCoreApi`) includes a custom `ActivitySource` for distributed tracing:

### ActivitySource: `AspireWithNode.WeatherApi`

**Activity Name:** `GetWeatherForecast`

**Tags:**
- `city`: The requested city name
- `forecast.days`: Number of days in the forecast (always 5)

**Events:**
- `ForecastGenerated`: Emitted when the forecast is successfully generated
  - `forecast.count`: Number of forecast items
  - `city`: The city name

### Viewing Custom Activities

1. Run the application using `aspire run` or through Visual Studio/VS Code
2. Open the Aspire Dashboard
3. Navigate to the "Traces" section
4. Look for traces from the weather API
5. Expand a trace to see the custom `GetWeatherForecast` activity with its tags and events

## Custom Metrics

### Backend Metrics (AspireWithNode.AspNetCoreApi)

The weather API exposes the following custom metrics:

| Metric Name | Type | Unit | Description | Dimensions |
|-------------|------|------|-------------|------------|
| `weather.forecast.requests` | Counter | requests | Total number of weather forecast requests | `city` |
| `weather.forecast.duration` | Histogram | ms | Duration of weather forecast request processing | `city` |
| `weather.forecast.city.requests` | Counter | requests | Number of requests per city | `city` |

### Frontend Metrics (NodeFrontend)

The Node.js frontend exposes the following custom cache metrics:

| Metric Name | Type | Unit | Description | Dimensions |
|-------------|------|------|-------------|------------|
| `cache.hits` | Counter | hits | Number of cache hits | `city` |
| `cache.misses` | Counter | misses | Number of cache misses | `city` |
| `cache.hit_rate` | ObservableGauge | % | Real-time cache hit rate percentage | none |
| `fetch.success` | Counter | requests | Number of successful fetches by attempt number | `city`, `attempt` |

### Viewing Custom Metrics

1. Run the application
2. Open the Aspire Dashboard
3. Navigate to the "Metrics" section
4. Search for metrics:
   - Backend: `weather.forecast.*`
   - Frontend: `cache.*`
5. Create charts to visualize:
   - Request counts per city
   - Request duration distribution
   - Cache hit/miss rates
   - Overall cache effectiveness
   - Retry success rates by attempt number

### Example Queries

In the dashboard metrics viewer, you can:
- View `weather.forecast.requests` broken down by `city` dimension to see which cities are most popular
- Analyze `weather.forecast.duration` to identify performance issues
- Track `weather.forecast.city.requests` to monitor city-specific request patterns
- Monitor `cache.hits` and `cache.misses` by city to understand caching effectiveness
- Watch `cache.hit_rate` to see real-time cache performance (higher is better)
- Analyze `fetch.success` by `attempt` dimension to see retry patterns:
  - `attempt=1`: Requests that succeeded on first try
  - `attempt=2`: Requests that required one retry
  - `attempt=3`: Requests that required two retries
- For Phoenix specifically, filter `fetch.success` by `city=Phoenix` to see the retry distribution

### Cache Statistics Endpoint

The frontend also exposes a `/cache-stats` endpoint that returns current cache statistics:

```bash
curl http://localhost:5223/cache-stats
```

Response:
```json
{
  "hits": 42,
  "misses": 15,
  "total": 57,
  "hitRate": "73.68%"
}
```

## City Parameter

The weather API now accepts an optional `city` query parameter:

```http
GET /weatherforecast?city=Seattle
GET /weatherforecast?city=Miami
GET /weatherforecast?city=Chicago
```

### Available Cities

The following mock cities are available, each with different temperature ranges:

| City | Min Temp (°C) | Max Temp (°C) | Notes |
|------|---------------|---------------|-------|
| Seattle | -5 | 25 | Default city |
| Miami | 15 | 35 | |
| Chicago | -15 | 30 | |
| Phoenix | 5 | 45 | |
| Boston | -10 | 28 | **Always throws an error** (for testing error handling) |

If no city is specified, **Seattle** is used as the default.

### Error Simulation

**Boston** is configured to always throw an error to demonstrate:
- Error handling and logging in both frontend and backend
- Error tracking in distributed traces
- Graceful error display to users
- Activity tagging with error information

## Frontend Changes

The Node.js frontend has been updated to:
- Accept a `city` query parameter (e.g., `http://localhost:5223/?city=Miami`)
- Display the selected city in the page title
- Include city-selection links for easy switching
- Cache forecasts per city (separate cache keys for each city)
- Log city information in requests
- Track and export cache hit/miss metrics to OpenTelemetry
- Expose a `/cache-stats` endpoint for monitoring cache performance

### Testing the Feature

1. Start the application
2. Navigate to the frontend (typically `http://localhost:5223`)
3. Click on different city links to see weather forecasts for different cities
4. **Click on Boston** to see the error handling in action
5. Observe in the Aspire Dashboard:
   - Custom traces with city tags
   - Metrics showing requests per city
   - Different temperature ranges for each city
   - Error traces for Boston with error tags and events
   - Error logs in the logging view

## Implementation Details

### Backend (C#)

```csharp
// Create ActivitySource for custom tracing
var activitySource = new ActivitySource("AspireWithNode.WeatherApi");

// Create Meter for custom metrics
var meter = new Meter("AspireWithNode.WeatherApi");
var forecastRequestCounter = meter.CreateCounter<long>("weather.forecast.requests");
var forecastRequestDuration = meter.CreateHistogram<double>("weather.forecast.duration");
var cityRequestCounter = meter.CreateCounter<long>("weather.forecast.city.requests");

// In the endpoint handler
using var activity = activitySource.StartActivity("GetWeatherForecast");
activity?.SetTag("city", normalizedCity);
forecastRequestCounter.Add(1, new KeyValuePair<string, object?>("city", normalizedCity));
```

### ServiceDefaults Configuration

The custom ActivitySource and Meter are registered in `Extensions.cs`:

```csharp
.WithMetrics(metrics =>
{
    metrics.AddMeter("AspireWithNode.WeatherApi");
})
.WithTracing(tracing =>
{
    tracing.AddSource("AspireWithNode.WeatherApi");
})
```

### Frontend (Node.js)

**instrumentation.js** - Create custom metrics:
```javascript
import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('nodefrontend');

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
```

**app.js** - Record metrics:
```javascript
const city = req.query.city || 'Seattle';
const cacheKey = `forecasts:${city}`;

if (cache) {
    const cachedForecasts = await cache.get(cacheKey);
    if (cachedForecasts) {
        recordCacheHit(city); // Record cache hit
        // ... return cached data
    }
}

recordCacheMiss(city); // Record cache miss
const response = await fetch(`${config.apiServer}/weatherforecast?city=${encodeURIComponent(city)}`);
```

## Error Handling and Observability

### Boston - Permanent Error

The Boston city intentionally throws a permanent error to demonstrate comprehensive error observability:

**Backend Error Handling**

When Boston is requested, the API:
1. Sets `error` tag to `true` on the activity
2. Sets `error.type` tag to `ServiceUnavailable`
3. Adds an `Error` event with error message details
4. Logs an error message with structured logging
5. Throws an `InvalidOperationException`

### Phoenix - Transient Errors with Retry

The Phoenix city demonstrates resilience patterns with transient errors and automatic retry:

**Backend Transient Error (Deterministic on First Attempt, Random on Subsequent)**

When Phoenix is requested, the API receives an `attempt` parameter from the frontend:
- **Attempt 1**: Always fails (100% failure rate)
- **Attempt 2+**: 50% chance of failure (random)

When a failure occurs, the API will:
1. Set `error` tag to `true` on the activity
2. Set `error.type` tag to `TransientError`
3. Set `attempt` tag showing which attempt failed
4. Add an `Error` event with transient error details
5. Log a warning message with the attempt number
6. Throw an `InvalidOperationException` with a retry-friendly message

This simulates realistic transient errors where the first attempt always fails when data is not cached, and subsequent attempts may still fail randomly.

**Frontend Retry Logic**

The frontend implements resilient retry logic:
1. Attempts up to 3 times to fetch the forecast
2. Passes the current `attempt` number (1, 2, or 3) to the backend API via query parameter
3. Each retry creates a separate span: `fetch_forecast_attempt_1`, `fetch_forecast_attempt_2`, `fetch_forecast_attempt_3`
4. Each span includes:
   - Attributes: `city`, `attempt`, `max_retries`
   - Events: fetch start, success/error details
   - Error tags on failed attempts
5. Implements exponential backoff between retries (1s, 2s, 4s)
6. Only shows error to user after all retries are exhausted

**Viewing Retry Traces**

In the Aspire Dashboard Traces view:
1. Request Phoenix weather forecast (ensure not cached by waiting 30+ seconds or restarting)
2. Find traces with multiple `fetch_forecast_attempt_X` spans
3. Observe:
   - First attempt (`fetch_forecast_attempt_1`) will always show an error with `attempt=1` tag
   - Second attempt (`fetch_forecast_attempt_2`) has 50% chance of success or error
   - Third attempt (`fetch_forecast_attempt_3`) has 50% chance of success or error
   - Timing shows exponential backoff delays (1s, 2s, 4s) between attempts
   - All retry attempts are visible as separate spans in the same trace
   - Some traces may require all 3 attempts, others may succeed on attempt 2
4. Once cached, subsequent Phoenix requests succeed immediately on first attempt (cache hit, no retries)

### Frontend Error Handling

The frontend gracefully handles API errors by:
1. Catching fetch errors and HTTP error responses
2. Logging detailed error information
3. Displaying a user-friendly error message in red
4. Rendering an empty forecast list
5. Allowing users to select different cities

### Observing Errors in Aspire Dashboard

When you click on Boston, observe:

**Traces View:**
- Look for traces with red error indicators
- Expand the trace to see the `GetWeatherForecast` activity
- View error tags: `error=true`, `error.type=ServiceUnavailable`
- See the `Error` event with the error message
- Notice the trace spans show the error propagation

**Logs View:**
- Filter by "Error" severity level
- See backend error: "Weather service error for Boston"
- See frontend error: "API returned error" with status code and details

**Metrics View:**
- Error requests still increment the request counters
- Duration metrics show how quickly errors are returned
- Cache misses are recorded (errors aren't cached)

This demonstrates how distributed tracing helps identify where errors occur and how they propagate through the system.

## Benefits

These custom observability features provide:

1. **Better debugging**: Track request flow through the system with custom activities
2. **Performance insights**: Monitor request duration per city to identify bottlenecks
3. **Usage analytics**: Understand which cities are most frequently requested
4. **Correlation**: Link frontend requests to backend processing via distributed tracing
5. **Business metrics**: Track application-specific metrics beyond standard HTTP metrics
6. **Cache optimization**: Monitor cache effectiveness to tune TTL and capacity
7. **Cost analysis**: Understand cache hit rates to optimize infrastructure costs
8. **Error tracking**: Comprehensive error visibility across distributed services

## Further Enhancements

Potential improvements:
- Add custom spans for cache operations with timing
- Add baggage propagation for cross-service context
- Create custom dashboards in Grafana or similar tools
- Add alerts based on custom metrics thresholds (e.g., cache hit rate < 50%)
- Track cache size and memory usage metrics
- Add metrics for API response times from frontend perspective
- Implement distributed tracing spans for Redis operations
