import OpenAI from 'openai';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));

const apiKey = (process.env.NVIDIA_KEY || config.nvidiaKey)?.trim();

let client = null;
if (apiKey) {
    client = new OpenAI({
        apiKey,
        baseURL: 'https://integrate.api.nvidia.com/v1',
    });
    console.log(`🔑 Loaded NVIDIA API key`);
} else {
    console.warn(`⚠️ No NVIDIA API key found in environment (NVIDIA_KEY) or config.json!`);
}

// Cache of available models
export let availableModels = [];

/**
 * Fetch available models from Nvidia API on startup
 */
export async function fetchNvidiaModels() {
    if (!client) return;
    try {
        const response = await client.models.list();
        availableModels = response.data.map(m => m.id);
        console.log(`✅ Loaded ${availableModels.length} models from NVIDIA API`);
    } catch (error) {
        console.error('❌ Failed to fetch Nvidia models:', error.message);
    }
}

/**
 * Find the best matching model from Nvidia's catalog based on a search term
 */
export function fuzzyMatchModel(searchTerm) {
    if (!availableModels.length) return null;
    
    const searchLow = searchTerm.toLowerCase();
    
    // Exact partial match
    const bestMatch = availableModels.find(m => m.toLowerCase().includes(searchLow));
    if (bestMatch) return bestMatch;

    // Fallback split match
    const terms = searchLow.split(' ');
    const fallbackMatch = availableModels.find(m => {
        const mLow = m.toLowerCase();
        return terms.every(t => mLow.includes(t));
    });

    return fallbackMatch || null;
}

/**
 * Stream generate content using OpenAI SDK format targeting NVIDIA NIM
 * 
 * @param {string} prompt - The user prompt
 * @param {string} modelName - e.g. 'meta/llama3-70b-instruct'
 * @param {string} [systemInstruction] - Optional system prompt
 * @param {Array} [history] - Conversation history array
 * @returns {AsyncGenerator<string>} - Async generator of text chunks
 */
export async function* streamGenerateNvidia(prompt, modelName, systemInstruction, history = [], imageBase64 = null) {
    if (!client) {
        throw new Error('No NVIDIA API key configured! Please set NVIDIA_KEY in environment variables.');
    }

    // Convert Gemini history format to OpenAI messages format
    const messages = [];
    
    if (systemInstruction) {
        messages.push({ role: 'system', content: systemInstruction });
    }

    // Gemini stores history as {role: 'user'|'model', parts: [{text: '...'}]}
    for (const turn of history) {
        messages.push({
            role: turn.role === 'model' ? 'assistant' : 'user',
            content: turn.parts[0].text
        });
    }

    // Add current prompt
    if (imageBase64) {
        messages.push({ 
            role: 'user', 
            content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
            ] 
        });
    } else {
        messages.push({ role: 'user', content: prompt });
    }

    const stream = await client.chat.completions.create({
        model: modelName,
        messages: messages,
        temperature: 0.7,
        max_tokens: 4096,
        stream: true,
    });

    for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || '';
        if (text) {
            yield text;
        }
    }
}
