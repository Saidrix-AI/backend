process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-at-least-16-chars";
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/placeholder-overridden-in-tests";
process.env.LLM_PROVIDER = "google";
process.env.GOOGLE_API_KEY = "test-key";
