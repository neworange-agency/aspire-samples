using System.Diagnostics;
using System.Diagnostics.Metrics;

var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();

// Add services to the container.

var app = builder.Build();

app.MapDefaultEndpoints();

// Configure the HTTP request pipeline.

app.UseHttpsRedirection();

var summaries = new[]
{
    "Freezing", "Bracing", "Chilly", "Cool", "Mild", "Warm", "Balmy", "Hot", "Sweltering", "Scorching"
};

// Mock cities with different temperature ranges
var cities = new Dictionary<string, (int MinTemp, int MaxTemp)>
{
    ["Seattle"] = (-5, 25),
    ["Miami"] = (15, 35),
    ["Chicago"] = (-15, 30),
    ["Phoenix"] = (5, 45),
    ["Boston"] = (-10, 28)
};

// Create custom ActivitySource for distributed tracing
var activitySource = new ActivitySource("AspireWithNode.WeatherApi");

// Create custom Meter for metrics
var meter = new Meter("AspireWithNode.WeatherApi");
var forecastRequestCounter = meter.CreateCounter<long>("weather.forecast.requests", "requests", "Number of weather forecast requests");
var forecastRequestDuration = meter.CreateHistogram<double>("weather.forecast.duration", "ms", "Duration of weather forecast requests");
var cityRequestCounter = meter.CreateCounter<long>("weather.forecast.city.requests", "requests", "Number of requests per city");

app.MapGet("/weatherforecast", (string? city = null) =>
{
    // Start custom activity for distributed tracing
    using var activity = activitySource.StartActivity("GetWeatherForecast");
    var stopwatch = Stopwatch.StartNew();
    
    // Default to Seattle if no city provided
    city ??= "Seattle";
    
    // Normalize city name
    var normalizedCity = cities.Keys.FirstOrDefault(c => 
        c.Equals(city, StringComparison.OrdinalIgnoreCase)) ?? "Seattle";
    
    // Simulate error for Boston
    if (normalizedCity.Equals("Boston", StringComparison.OrdinalIgnoreCase))
    {
        activity?.SetTag("error", true);
        activity?.SetTag("error.type", "ServiceUnavailable");
        activity?.AddEvent(new ActivityEvent("Error", 
            tags: new ActivityTagsCollection
            {
                ["error.message"] = "Weather service unavailable for Boston"
            }));
        
        app.Logger.LogError("Weather service error for {City}", normalizedCity);
        throw new InvalidOperationException($"Weather service is currently unavailable for {normalizedCity}");
    }
    
    // Add tags to the activity
    activity?.SetTag("city", normalizedCity);
    activity?.SetTag("forecast.days", 5);
    
    // Get temperature range for the city
    var (minTemp, maxTemp) = cities[normalizedCity];
    
    // Record metrics
    forecastRequestCounter.Add(1, new KeyValuePair<string, object?>("city", normalizedCity));
    cityRequestCounter.Add(1, new KeyValuePair<string, object?>("city", normalizedCity));
    
    var forecast = Enumerable.Range(1, 5).Select(index =>
        new WeatherForecast
        (
            DateOnly.FromDateTime(DateTime.Now.AddDays(index)),
            Random.Shared.Next(minTemp, maxTemp),
            summaries[Random.Shared.Next(summaries.Length)],
            normalizedCity
        ))
        .ToArray();
    
    stopwatch.Stop();
    
    // Record duration metric
    forecastRequestDuration.Record(stopwatch.ElapsedMilliseconds, 
        new KeyValuePair<string, object?>("city", normalizedCity));
    
    // Add event to activity
    activity?.AddEvent(new ActivityEvent("ForecastGenerated", 
        tags: new ActivityTagsCollection
        {
            ["forecast.count"] = forecast.Length,
            ["city"] = normalizedCity
        }));
    
    app.Logger.LogInformation("Generated weather forecast for {City} with {Count} days", 
        normalizedCity, forecast.Length);
    
    return forecast;
});

app.Run();

record WeatherForecast(DateOnly Date, int TemperatureC, string? Summary, string City)
{
    public int TemperatureF => 32 + (int)(TemperatureC / 0.5556);
}
