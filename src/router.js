import { quickGenerate, config } from './gemini.js';

const CLASSIFIER_PROMPT = `You are a prompt complexity classifier. Classify the following user prompt as LEVEL1, LEVEL2, or LEVEL3.

LEVEL1 (Simple) = factual questions, greetings, translations, definitions, short answers, casual conversation.
LEVEL2 (Moderate) = math problems, code generation, debugging, detailed technical explanations, writing essays, data formatting.
LEVEL3 (Extreme) = extreme reasoning, highly complex multi-step analysis, advanced mathematics, deep logic puzzles, obscure esoteric requests, or prompts that require the absolute maximum intelligence and reasoning capability.

Reply with ONLY ONE WORD: LEVEL1, LEVEL2, or LEVEL3

User prompt: `;

/**
 * Determines the best model(s) to use for a given prompt.
 * 
 * @param {string} prompt - The user's prompt
 * @returns {Promise<Array<{provider: string, name: string}>>} - Array of model configs to use
 */
export async function selectModel(prompt) {
    const tier1 = config.models.tier1;       
    const tier2 = config.models.tier2; 
    const tier3 = config.models.tier3; 
    const classifier = config.models.classifier;

    // Very short prompts (< 15 chars) → always use tier1
    if (prompt.trim().length < 15) {
        console.log(`🧠 Router: Short prompt → LEVEL1 (1 model)`);
        return tier1;
    }

    try {
        const classification = await quickGenerate(
            CLASSIFIER_PROMPT + prompt,
            classifier.name
        );

        const result = classification.trim().toUpperCase();
        
        if (result.includes('LEVEL3')) {
            console.log(`🧠 Router: LEVEL3 EXTREME → Parallel Execution (${tier3.length} models)`);
            return tier3;
        } else if (result.includes('LEVEL2')) {
            console.log(`🧠 Router: LEVEL2 COMPLEX → ${tier2[0].name}`);
            return tier2;
        } else {
            console.log(`🧠 Router: LEVEL1 SIMPLE → ${tier1[0].name}`);
            return tier1;
        }
    } catch (error) {
        // If classification fails, default to tier1 model
        console.log(`🧠 Router: Classification failed, defaulting → LEVEL1`);
        return tier1;
    }
}

/**
 * Uses a fast model to check if the prompt is asking to generate a picture/image.
 */
export async function analyzeIntent(prompt) {
    if (prompt.trim().length < 5) return false;
    
    // Quick regex check first for speed
    if (/^\s*(?:draw|generate|create|paint|render)\s+(?:an image|a picture|a photo|a logo|a 3d|art|a portrait|a landscape).*/i.test(prompt) || /^\s*(?:imagine|draw|sketch|generate image)\b/i.test(prompt)) {
        return true;
    }

    // Deep LLM verify
    try {
        const checkPrompt = `Does this user request strictly ask to generate/draw/create a visual image/picture? Reply with ONLY the word YES or NO.\n\nPrompt: "${prompt}"`;
        const res = await quickGenerate(checkPrompt, config.models.classifier.name);
        return res.toUpperCase().includes('YES');
    } catch(e) {
        return false;
    }
}
