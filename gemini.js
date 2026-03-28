import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));

const envKeys = process.env.GEMINI_KEYS || '';
const configKeys = (config.apiKeys || []).filter(k => k && k.trim().length > 0);

// Prioritize environment variables, then fallback to config
const apiKeys = envKeys ? envKeys.split(',').map(k => k.trim()).filter(k => k) : configKeys;

let currentKeyIndex = 0;
let exhaustedKeys = new Set();

if (apiKeys.length === 0) {
    console.warn('⚠️ No Gemini API keys found in environment (GEMINI_KEYS) or config.json!');
} else {
    console.log(`🔑 Loaded ${apiKeys.length} Gemini API key(s)`);
}

/**
 * Get the current active GoogleGenerativeAI instance
 */
function getClient() {
    return new GoogleGenerativeAI(apiKeys[currentKeyIndex]);
}

/**
 * Rotate to the next available API key.
 * Returns true if a new key is available, false if all exhausted.
 */
function rotateKey() {
    exhaustedKeys.add(currentKeyIndex);
    
    // Find next non-exhausted key
    for (let i = 0; i < apiKeys.length; i++) {
        const nextIndex = (currentKeyIndex + 1 + i) % apiKeys.length;
        if (!exhaustedKeys.has(nextIndex)) {
            currentKeyIndex = nextIndex;
            console.log(`🔄 Rotated to API key #${currentKeyIndex + 1}`);
            return true;
        }
    }
    
    // All keys exhausted — reset and try again after cooldown
    console.log('⚠️ All API keys exhausted. Resetting cooldown...');
    exhaustedKeys.clear();
    currentKeyIndex = 0;
    return false;
}

/**
 * Check if an error is a rate limit / quota error that warrants key rotation
 */
function isQuotaError(error) {
    const msg = (error?.message || '').toLowerCase();
    const status = error?.status || error?.httpStatusCode || 0;
    return (
        status === 429 ||
        status === 503 ||
        msg.includes('resource_exhausted') ||
        msg.includes('quota') ||
        msg.includes('rate limit') ||
        msg.includes('too many requests') ||
        msg.includes('overloaded')
    );
}

/**
 * Stream generate content with automatic key rollover.
 * Yields text chunks as they arrive.
 * 
 * @param {string} prompt - The user prompt
 * @param {string} modelName - Gemini model name (e.g. 'gemini-2.5-flash')
 * @param {string} [systemInstruction] - Optional system prompt
 * @param {Array} [history] - Conversation history array
 * @returns {AsyncGenerator<string>} - Async generator of text chunks
 */
export async function* streamGenerate(prompt, modelName, systemInstruction, history = []) {
    const maxRetries = apiKeys.length + 1;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const client = getClient();
            const modelConfig = { model: modelName };
            
            if (systemInstruction) {
                modelConfig.systemInstruction = systemInstruction;
            }

            const model = client.getGenerativeModel(modelConfig);
            
            // Build the contents array combining history and the new prompt
            const contents = [...history, { role: 'user', parts: [{ text: prompt }] }];

            const result = await model.generateContentStream({
                contents: contents,
                generationConfig: {
                    temperature: 0.7,
                    topP: 0.95,
                    maxOutputTokens: 8192,
                },
            });

            for await (const chunk of result.stream) {
                const text = chunk.text();
                if (text) {
                    yield text;
                }
            }
            
            return; // Success — exit the retry loop
            
        } catch (error) {
            if (isQuotaError(error)) {
                console.log(`⚡ Key #${currentKeyIndex + 1} hit rate limit. Rotating...`);
                const hasMore = rotateKey();
                if (!hasMore && attempt < maxRetries - 1) {
                    // All exhausted, wait 5 seconds before retrying from first key
                    console.log('⏳ Waiting 5s before retrying...');
                    await new Promise(r => setTimeout(r, 5000));
                }
                continue;
            }
            // Non-quota error — throw immediately
            throw error;
        }
    }
    
    throw new Error('All API keys exhausted after retries. Please add more keys or wait.');
}

/**
 * Non-streaming single generate (used for classification)
 */
export async function quickGenerate(prompt, modelName) {
    const maxRetries = apiKeys.length + 1;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const client = getClient();
            const model = client.getGenerativeModel({ model: modelName });
            const result = await model.generateContent(prompt);
            return result.response.text();
        } catch (error) {
            if (isQuotaError(error)) {
                console.log(`⚡ Key #${currentKeyIndex + 1} hit rate limit (classify). Rotating...`);
                rotateKey();
                continue;
            }
            throw error;
        }
    }
    
    throw new Error('All API keys exhausted during classification.');
}

export { config };

/**
 * Generate an image using the user provided API key for gemini-2.5-flash-image
 */
export async function generateImageGemini(prompt) {
    const imageApiKey = process.env.GEMINI_IMAGE_KEY || apiKeys[0];
    if (!imageApiKey) throw new Error('No Gemini API key available for image generation.');
    const genAI = new GoogleGenerativeAI(imageApiKey);
    
    for (let i = 0; i < 3; i++) {
        try {
            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-image' });
            const result = await model.generateContent(prompt);
            
            const parts = result.response?.candidates?.[0]?.content?.parts || [];
            for (const p of parts) {
                if (p.inlineData && p.inlineData.data) {
                    return Buffer.from(p.inlineData.data, 'base64');
                }
            }
            throw new Error('No valid image data generated in response.');
        } catch (error) {
            console.error('Image Gen attempt failed:', error.message);
            if (error.message.includes('retry') || error.message.includes('429')) {
                console.log('Image API rate limited... waiting 10s to retry...');
                await new Promise(r => setTimeout(r, 10000));
                continue;
            }
            throw error;
        }
    }
    throw new Error('Image generation failed due to strict strict rate limits or errors.');
}
