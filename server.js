require('dotenv').config();
const express = require('express');
const axios = require('axios');
const redis = require('redis');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;

// -------------------------------------------------------------
// Middleware: Rate Limiting
// Prevents API abuse by limiting each IP to 100 requests / 15m
// -------------------------------------------------------------
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per `window`
    message: { error: 'Too many requests from this IP, please try again after 15 minutes.' },
    standardHeaders: true, 
    legacyHeaders: false, 
});

// Apply rate limiter to all API requests
app.use('/api/', limiter);

// Serve the static frontend UI
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------------
// Redis Client Setup
// -------------------------------------------------------------
let redisClient;

(async () => {
    redisClient = redis.createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379'
    });

    redisClient.on('error', (error) => console.error(`Redis Error: ${error}`));
    redisClient.on('connect', () => console.log('Connected to Redis Cache!'));

    await redisClient.connect();
})();

// -------------------------------------------------------------
// Core Route: Get Weather
// -------------------------------------------------------------
app.get('/api/weather/:city', async (req, res) => {
    const city = req.params.city.toLowerCase().trim();

    try {
        // Step 1 & 2: Check Redis Cache First
        const cacheKey = `weather:${city}`;
        const cachedData = await redisClient.get(cacheKey);

        if (cachedData) {
            console.log(`[CACHE HIT] Returning cached data for: ${city}`);
            const responseData = JSON.parse(cachedData);
            // Appending a custom header/flag so the client knows it was cached
            responseData._source = 'Redis Cache'; 
            return res.json(responseData);
        }

        // Step 3: Request 3rd Party Weather API (Cache Miss)
        console.log(`[CACHE MISS] Fetching fresh data from 3rd party API for: ${city}`);
        
        if (!WEATHER_API_KEY) {
            return res.status(500).json({ error: 'Weather API key is not configured on the server.' });
        }

        // Fetching data from Visual Crossing
        const weatherApiUrl = `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${encodeURIComponent(city)}?key=${WEATHER_API_KEY}`;
        const response = await axios.get(weatherApiUrl);
        const weatherData = response.data;
        weatherData._source = '3rd Party API';

        // Step 5: Save Cached Results (with Expiration)
        // Set Expiration (EX) to 43200 seconds (12 hours)
        await redisClient.setEx(cacheKey, 43200, JSON.stringify(weatherData));

        // Step 4: Weather API Response to Client
        res.json(weatherData);

    } catch (error) {
        console.error(`Error fetching weather for ${city}:`, error.message);
        
        // Handle specific 3rd party API errors (e.g., city not found)
        if (error.response && error.response.status === 400) {
            return res.status(400).json({ error: 'Invalid city name or bad request.' });
        }
        
        res.status(500).json({ error: 'An error occurred while fetching weather data.' });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Weather API server is running on http://localhost:${PORT}`);
});