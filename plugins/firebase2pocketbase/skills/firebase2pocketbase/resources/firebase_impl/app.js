import PocketBase from 'pocketbase';

// Default PocketBase URL if not specified
const DEFAULT_PB_URL = 'http://127.0.0.1:8090';

/**
 * Mocks the Firebase initializeApp function.
 * Initializes the PocketBase client.
 * 
 * @param {Object} config - The configuration object (mapped from Firebase config).
 * @returns {PocketBase} The initialized PocketBase client instance (acting as 'app').
 */
export function initializeApp(config = {}) {
    // In a real scenario, we might parse config to find a specific PB URL,
    // but for this local wrapper, we default to localhost or allow an override.
    const url = config.pocketbaseUrl || DEFAULT_PB_URL;
    
    // Create the PocketBase instance
    const pb = new PocketBase(url);
    
    // Store config for potential retrieval
    pb._config = config;
    
    console.log(`[Firebase Wrapper] Initialized PocketBase at ${url}`);
    
    return pb;
}

export default { initializeApp };
