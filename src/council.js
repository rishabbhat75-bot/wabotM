import { streamGenerateNvidia } from './nvidia.js';
import { streamGenerate } from './gemini.js';

/**
 * Execute a single AI node strictly and return the accumulated full response.
 * @param {string} provider 'nvidia' or 'gemini'
 * @param {string} modelName 
 * @param {string} systemInstruction 
 * @param {string} prompt 
 * @param {string|null} imageBase64 
 */
async function executeNode(provider, modelName, systemInstruction, prompt, imageBase64 = null) {
    let accumulated = '';
    const stream = provider === 'nvidia' 
        ? streamGenerateNvidia(prompt, modelName, systemInstruction, [], imageBase64)
        : streamGenerate(prompt, modelName, systemInstruction, []); // Note: standard gemini implementation might not support imageBase64 via streamGenerate

    for await (const chunk of stream) {
        accumulated += chunk;
    }
    return accumulated.trim();
}

/**
 * Parses the raw Judge XML score if present: <SCORE>X</SCORE>
 */
function parseJudgeScore(judgeOutput) {
    const match = judgeOutput.match(/<SCORE>(\d+)<\/SCORE>/i);
    if (match && match[1]) {
        return parseInt(match[1], 10);
    }
    return 10; // default to pass if no format found
}

/**
 * Runs the 9-Member AI Council orchestration recursively (max 1 retry).
 * @param {string} userPrompt The original raw prompt
 * @param {string|null} imageBase64 Base64 encoded image if present
 * @param {function} statusCallback e.g. async (statusMessage) => {...}
 */
export async function runCouncil(userPrompt, imageBase64, statusCallback) {
    let currentPromptContext = userPrompt;
    
    // 1. Observer (Vision)
    if (imageBase64) {
        await statusCallback('👁️ *Council Stage 1/6:*\n`Observer is extracting visual context...`');
        const observerSystem = "You are the Observer. Describe this image with meticulous technical detail. Do not hold back any information. Feed this to the Interpreter.";
        try {
            // using nvidia provider for vision as per user request (google/gemma-3-27b-it via NIM or OpenRouter)
            const observerOutput = await executeNode('nvidia', 'google/gemma-3-27b-it', observerSystem, "Describe this visual data completely.", imageBase64);
            currentPromptContext = `[VISUAL CONTEXT FROM OBSERVER]:\n${observerOutput}\n\n[USER PROMPT]:\n${userPrompt}`;
        } catch (e) {
            currentPromptContext = `[VISUAL CONTEXT FROM OBSERVER FAILED TO EXTRACT: ${e.message}]\n\n[USER PROMPT]:\n${userPrompt}`;
        }
    }

    // 2. Interpreter
    await statusCallback('🧠 *Council Stage 2/6:*\n`Interpreter is mapping your intent...`');
    const interpreterSystem = "You are the Interpreter (deepseek-V3.2). Break down the user's request into a strict list of requirements, hidden constraints, and goals. Output an Intent Map.";
    const intentMap = await executeNode('nvidia', 'deepseek-ai/deepseek-v3.2', interpreterSystem, currentPromptContext);

    // Enter Main Execution/Retry Loop
    let attempt = 1;
    let finalArtistOutput = "";
    let finalScore = 0;
    
    while (attempt <= 2) {
        const attemptPrefix = attempt > 1 ? `*(REDO ATTEMPT ${attempt})*\n` : '';

        // 3. Manager
        await statusCallback(`👨‍💼 *Council Stage 3/6:*\n${attemptPrefix}\`Manager is constructing the Mission Plan... \``);
        const managerSystem = "You are the Manager (Llama-3.1-405B). Take the Intent Map and create a Mission Plan. Delegate sub-tasks contextually to the Scientist (Data/Facts), Architect (Code/Logic), and Polymath (Strategy/Nuance). Keep delegation clear.";
        const missionPlan = await executeNode('nvidia', 'meta/llama-3.1-405b-instruct', managerSystem, `[INTENT MAP]:\n${intentMap}`);

        // 4. Specialists (Parallel)
        await statusCallback(`⚙️ *Council Stage 4/6:*\n${attemptPrefix}\`Specialists (Scientist, Architect, Polymath) are working in parallel... \``);
        
        const scientistSys = "You are the Scientist (Qwen 3.5). Focus on facts, deep research, heavy technical data, and academic-level information. Fulfill your part of the Mission Plan strictly.";
        const architectSys = "You are the Architect (Qwen 2.5 Coder). Focus on structural logic, code, mathematics, and system design with rigid precision. Fulfill your part of the Mission Plan strictly.";
        const polymathSys = "You are the Polymath (Mistral Large 2). Manage complex decision-making, ethical nuance, and high-level conceptual planning. Fulfill your part of the Mission Plan strictly.";
        
        const parallelTasks = [
            executeNode('nvidia', 'qwen/qwen3.5-397b-a17b', scientistSys, `[MISSION PLAN]:\n${missionPlan}`).catch(e => `[Scientist Failed: ${e.message}]`),
            executeNode('nvidia', 'qwen/qwen2.5-coder-32b-instruct', architectSys, `[MISSION PLAN]:\n${missionPlan}`).catch(e => `[Architect Failed: ${e.message}]`),
            executeNode('nvidia', 'mistralai/mistral-large-2-instruct', polymathSys, `[MISSION PLAN]:\n${missionPlan}`).catch(e => `[Polymath Failed: ${e.message}]`)
        ];

        const [scientistData, architectData, polymathData] = await Promise.all(parallelTasks);
        
        const combinedSpecialistData = `[SCIENTIST OUTPUT]:\n${scientistData}\n\n[ARCHITECT OUTPUT]:\n${architectData}\n\n[POLYMATH OUTPUT]:\n${polymathData}`;

        // 5. Cynic
        await statusCallback(`🛡️ *Council Stage 5/6:*\n${attemptPrefix}\`Cynic is stress-testing the logic... \``);
        const cynicSys = "You are the Cynic (DeepSeek R1). Find errors, logic gaps, or hallucinations in the specialists' work. Read the Intent Map to ensure the goal is met. Think step-by-step and output your corrections and stress-test results.";
        const cynicOutput = await executeNode('nvidia', 'deepseek-ai/deepseek-r1-distill-qwen-32b', cynicSys, `[INTENT MAP]:\n${intentMap}\n\n[SPECIALIST AGGREGATION]:\n${combinedSpecialistData}`);

        // 6. Artist
        await statusCallback(`🎨 *Council Stage 6/6:*\n${attemptPrefix}\`Artist is polishing the final response... \``);
        const artistSys = `You are the Artist (Palmyra Creative). Take the raw technical data from specialists and the corrections from the Cynic, and polish the final output into clear, professional, human-centric language.
CRITICAL FORMATTING INSTRUCTIONS for WhatsApp:
- Use *bold* for headings.
- Use _italics_ for subheadings.
- Keep paragraphs extremely short.
- Use \`\`\` (triple backticks) for code.
- Provide absolute maximum intelligence without technical jargon overload unless necessary.
Do NOT introduce yourself as the Artist. Simply provide the polished answer.`;
        
        finalArtistOutput = await executeNode('nvidia', 'writer/palmyra-creative-122b', artistSys, `[CYNIC CORRECTIONS]:\n${cynicOutput}\n\n[SPECIALIST RAW DATA]:\n${combinedSpecialistData}`);

        // 7. Judge
        await statusCallback(`⚖️ *Final Judgement:*\n${attemptPrefix}\`Judge is evaluating the output... \``);
        const judgeSys = `You are the Judge (Nemotron Reward). Evaluate the Artist's final output against the original user prompt and Intent Map.
Score it strictly from 1 to 10 on precision, formatting, and correctness.
You MUST conclude your response with the exact string: <SCORE>X</SCORE> (where X is the number, e.g., <SCORE>8</SCORE>).`;
        
        const judgePrompt = `[ORIGINAL REQUEST]:\n${currentPromptContext}\n\n[INTENT MAP]:\n${intentMap}\n\n[FINAL ARTIST OUTPUT]:\n${finalArtistOutput}`;
        const judgeOutput = await executeNode('nvidia', 'nvidia/llama-3.1-nemotron-70b-reward', judgeSys, judgePrompt);
        
        finalScore = parseJudgeScore(judgeOutput);
        
        if (finalScore >= 8) {
            break; // Success! No redo needed.
        } else if (attempt === 1) {
            await statusCallback(`⚠️ *Council Redo Triggered!*\n\`Judge Score: ${finalScore}/10. Finding logic gaps and repeating pipeline...\``);
            // Wait a few seconds before restarting to prevent instant looping
            await new Promise(r => setTimeout(r, 4000));
        } else {
             // Second attempt finished, break anyway.
             break;
        }
        attempt++;
    }

    return { 
        text: finalArtistOutput, 
        score: finalScore 
    };
}
