import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import makeWASocket, { DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import { getAuthState } from './store.js';
import { streamGenerate, config, generateImageGemini } from './gemini.js';
import { selectModel, analyzeIntent } from './router.js';
import { fetchNvidiaModels, streamGenerateNvidia, fuzzyMatchModel, availableModels, generateImageNvidia } from './nvidia.js';
import { formatForWhatsApp, streamingIndicator, finalFormat } from './formatter.js';
import qrcode from 'qrcode-terminal';
import express from 'express';
import { parsePdfBuffer, createPdfBuffer, uploadToPastebin, googleSearch } from './tools.js';

const logger = pino({ level: 'silent' }); // suppress Baileys verbose logs

const PREFIX = config.commandPrefix || '.ask';
const EDIT_INTERVAL = config.streaming?.editIntervalMs || 600;
const MIN_CHUNK = config.streaming?.minChunkLength || 8;
const MAX_HISTORY_LENGTH = 20; // Keep track of the last 20 messages (10 turns) per chat

const chatHistories = new Map();

let START_TIME = Math.floor(Date.now() / 1000);
let botReady = false;
let globalQR = null;

let sock;
let myJid = null; // will be set after connection

/**
 * Start the WhatsApp bot
 */
async function startBot() {
    await fetchNvidiaModels();
    const { state, saveCreds } = await getAuthState();
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📡 Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        printQRInTerminal: false, // we handle QR ourselves for better display
        logger,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
    });

    // Connection events
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            globalQR = qr;
            const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(qr);

            console.log('\n\n\n'); // Add padding instead of clear() which breaks Render's log viewer
            console.log('╔════════════════════════════════════════════════════════════╗');
            console.log('║                   🤖 WhBot AI — QR Login                   ║');
            console.log('╠════════════════════════════════════════════════════════════╣');
            console.log('║ 👇 CLICK THE SECURE LINK BELOW TO VIEW YOUR QR CODE 👇     ║');
            console.log('╚════════════════════════════════════════════════════════════╝');
            console.log('\n' + qrUrl + '\n\n');
        }

        if (connection === 'open') {
            globalQR = 'connected';
            myJid = sock.user?.id;
            botReady = true;
            START_TIME = Math.floor(Date.now() / 1000);
            console.clear();
            console.log('╔══════════════════════════════════════╗');
            console.log('║       ✅ WhBot AI — Connected!        ║');
            console.log('╠══════════════════════════════════════╣');
            console.log(`║  Logged in as: ${(sock.user?.name || 'Unknown').padEnd(20)} ║`);
            console.log(`║  JID: ${(myJid || '').substring(0, 30).padEnd(30)} ║`);
            console.log(`║  Command: ${PREFIX} <your prompt>`.padEnd(39) + '║');
            console.log(`║  T1 (Daily): ${config.models.tier1[0].name}`.padEnd(39) + '║');
            console.log(`║  T2 (Coding): ${config.models.tier2[0].name}`.padEnd(39) + '║');
            console.log(`║  T3 (Council): ${config.models.tier3.length} Parallel Models`.padEnd(39) + '║');
            console.log('╚══════════════════════════════════════╝');
            console.log('');
            console.log('🟢 Listening for messages...');
        }

        if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`🔴 Disconnected. Status: ${statusCode}`);

            if (shouldReconnect) {
                console.log('🔄 Reconnecting in 3s...');
                setTimeout(startBot, 3000);
            } else {
                console.log('❌ Logged out. Delete auth_info/ folder and restart to re-login.');
            }
        }
    });

    // Save credentials on update
    sock.ev.on('creds.update', saveCreds);

    // Message handler
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (!botReady) return;
        if (type !== 'notify') return;

        for (const msg of messages) {
            await handleMessage(msg);
        }
    });
}

/**
 * Handle incoming messages — only respond to own .ask commands
 */
async function handleMessage(msg) {
    try {
        // Only process messages from self
        if (!msg.key.fromMe) return;

        // Ignore historical messages from sync (handle Long objects correctly)
        let msgTime = Number(msg.messageTimestamp);
        if (typeof msg.messageTimestamp === 'object') {
            if (typeof msg.messageTimestamp.toNumber === 'function') {
                msgTime = msg.messageTimestamp.toNumber();
            } else if ('low' in msg.messageTimestamp) {
                msgTime = msg.messageTimestamp.low;
            }
        }
        
        // If somehow the timestamp is in milliseconds instead of seconds
        if (msgTime > 10000000000) {
            msgTime = Math.floor(msgTime / 1000);
        }

        if (msgTime < START_TIME) return;

        // Get the text content
        const text = msg.message?.conversation
            || msg.message?.extendedTextMessage?.text
            || '';

        // Handle Media & Documents
        const msgType = Object.keys(msg.message || {})[0];
        const isImage = msgType === 'imageMessage' || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
        const isDoc = msgType === 'documentMessage' || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.documentMessage;

        let imageBase64 = null;
        if (isImage) {
            const mediaNode = msgType === 'imageMessage' ? msg : { ...msg, message: msg.message.extendedTextMessage.contextInfo.quotedMessage };
            try {
                const buffer = await downloadMediaMessage(mediaNode, 'buffer', {}, { logger });
                imageBase64 = buffer.toString('base64');
            } catch (e) {
                console.error('Image download failed', e);
            }
        }

        let pdfContext = '';
        if (isDoc) {
            const mediaNode = msgType === 'documentMessage' ? msg : { ...msg, message: msg.message.extendedTextMessage.contextInfo.quotedMessage };
            if (mediaNode.message.documentMessage?.mimetype === 'application/pdf') {
                try {
                    const buffer = await downloadMediaMessage(mediaNode, 'buffer', {}, { logger });
                    pdfContext = await parsePdfBuffer(buffer);
                    if (pdfContext) {
                        pdfContext = `[Extracted PDF Content:\n${pdfContext.substring(0, 15000)}]\n\n`; // cap length to avoid overloading tokens
                    }
                } catch (e) {
                    console.error('PDF Parse failed', e);
                }
            }
        }

        // --- SPECIAL COMMAND ROUTING ---
        // .help command
        if (text.trim() === '.help') {
            const helpMenu = `*🤖 WhBot Council — Tool Suite*\n\n` +
                `*Core Chat:*\n` +
                `• \`.ask <msg>\` - Talk to the AI router\n` +
                `• \`.ask "model" <msg>\` - Force a specific model\n` +
                `• \`.model\` - List all available models\n\n` +
                `*Tools:*\n` +
                `• \`.search <query>\` - Perform a live Google search\n` +
                `• \`.topdf <text>\` - Converts your text into a PDF file\n\n` +
                `*Auto-Features:*\n` +
                `• 🖼️ *Vision:* Send any image with a caption to analyze it via Llama-90B.\n` +
                `• 📄 *PDF Reader:* Send any PDF file with a prompt to read it.\n` +
                `• 💻 *Code Export:* Any large code output will automatically generate a Pastebin link for easy copying.`;
            await sock.sendMessage(msg.key.remoteJid, { text: helpMenu });
            return;
        }

        // .topdf command
        if (text.startsWith('.topdf ')) {
            const pdfInput = text.substring(7);
            await sock.sendMessage(msg.key.remoteJid, { text: `Processing PDF...` }, { quoted: msg });
            try {
                const pBuffer = await createPdfBuffer(pdfInput);
                await sock.sendMessage(msg.key.remoteJid, { 
                    document: pBuffer, 
                    mimetype: 'application/pdf', 
                    fileName: 'WhBot_Generated.pdf' 
                });
            } catch (e) {
                await sock.sendMessage(msg.key.remoteJid, { text: `❌ PDF generation failed.` });
            }
            return;
        }

        // .model command
        if (text.trim() === '.model') {
            const availableModelsMsg = `*🤖 Available AI Models*\n\n` +
                `*Quick Reference (Tiers):*\n` +
                `• Tier 1: ${config.models.tier1.map(m => m.name).join(', ')}\n` +
                `• Tier 2: ${config.models.tier2.map(m => m.name).join(', ')}\n` +
                `• Tier 3 (Council): ${config.models.tier3.map(m => m.name).join(', ')}\n\n` +
                `*All Available NVIDIA NIMs:*\n` +
                (availableModels.length ? `\`\`\`${availableModels.join('\n')}\`\`\`` : '_(Loading...)_') + `\n\n` +
                `_Use '.ask "model_name" your prompt' to force a specific model. You do not need to type the full name, just enough words to fuzzy match it!_`;

            await sock.sendMessage(msg.key.remoteJid, { text: availableModelsMsg });
            return;
        }

        let prompt = '';
        let isSelect = false;
        let forcedModelName = '';
        let requiresSearch = false;

        // Check for .search prefix
        if (text.startsWith('.search ')) {
            prompt = text.substring(8).trim();
            requiresSearch = true;
        }
        // Check for .ask prefix
        else if (text.startsWith(PREFIX + ' ') || text.startsWith(PREFIX + '"')) {
            // Parse .ask "model name" prompt
            const match = text.match(/^\.ask\s+"([^"]+)"\s+(.+)$/s);
            if (match) {
                isSelect = true;
                forcedModelName = match[1];
                prompt = match[2].trim();
            } else {
                prompt = text.substring(PREFIX.length + 1).trim();
            }
        } 
        // If it's a captioned image/PDF but doesn't have .ask matching, allow it to process the text if there is text.
        else if ((isImage || isDoc) && text.trim().length > 0) {
            prompt = text.trim();
        } else {
            return;
        }

        if (!prompt) return;

        const chatJid = msg.key.remoteJid;

        // Extract context if replying to a message
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const quotedMessage = contextInfo?.quotedMessage;
        let quotedText = '';
        if (quotedMessage) {
            // Find text in quoted message depending on its type
            quotedText = quotedMessage.conversation || 
                         quotedMessage.extendedTextMessage?.text || 
                         quotedMessage.imageMessage?.caption || 
                         quotedMessage.videoMessage?.caption || '';
        }

        // Build the final prompt with context
        let fullPrompt = prompt;

        if (requiresSearch) {
            const searchRes = await googleSearch(prompt);
            fullPrompt = `[Live Web Search Context:\n${searchRes}]\n\nUser Query: ${prompt}`;
        } else if (quotedText) {
            fullPrompt = `[Context - Replying to message: "${quotedText}"]\n\n${prompt}`;
        }

        if (pdfContext) {
            fullPrompt = pdfContext + fullPrompt;
        }

        console.log(`\n📨 Prompt: "${fullPrompt.substring(0, 80)}${fullPrompt.length > 80 ? '...' : ''}"\n   Chat: ${chatJid}`);

        // Get or initialize chat history for this user/group
        if (!chatHistories.has(chatJid)) {
            chatHistories.set(chatJid, []);
        }
        const history = chatHistories.get(chatJid);

        // Select model(s) based on prompt complexity or override
        let modelConfigs = [];
        let isImageIntent = false;

        if (imageBase64) {
             console.log(`👁️ Vision mode activated: Overriding router to Llama-3.2-90B-Vision`);
             modelConfigs = [{ provider: 'nvidia', name: 'meta/llama-3.2-90b-vision-instruct', imageBase64: imageBase64 }];
        } else if (isSelect) {
            if (forcedModelName.toLowerCase().includes('gemini') && forcedModelName.toLowerCase().includes('image')) {
                isImageIntent = true;
                modelConfigs = [{ provider: 'gemini_image', name: 'gemini-2.5-flash-image' }];
            } else if (forcedModelName.toLowerCase().includes('gemini')) {
                let gName = 'gemini-2.5-flash';
                if (forcedModelName.toLowerCase().includes('pro')) gName = 'gemini-1.5-pro';
                else if (forcedModelName.toLowerCase().includes('1.5-flash')) gName = 'gemini-1.5-flash';
                else if (forcedModelName.toLowerCase().includes('2.0-flash')) gName = 'gemini-2.0-flash';
                
                modelConfigs = [{ provider: 'gemini', name: gName }];
            } else {
                const matched = fuzzyMatchModel(forcedModelName);
                if (matched) {
                    modelConfigs = [{ provider: 'nvidia', name: matched }];
                } else {
                    await sock.sendMessage(chatJid, { text: `❌ Could not find a model matching "${forcedModelName}".`});
                    return;
                }
            }
        } else {
            isImageIntent = await analyzeIntent(fullPrompt);
            if (isImageIntent) {
                console.log(`🎨 Image Generation Intent Detected: Routing to Gemini 2.5 Flash Image`);
                modelConfigs = [{ provider: 'gemini_image', name: 'gemini-2.5-flash-image' }];
            } else {
                modelConfigs = await selectModel(fullPrompt);
            }
        }

        const isParallelCouncil = modelConfigs.length > 1;

        async function postProcessAndSend(finalText, editKey) {
            let finalOutput = finalText;
            const codeBlocks = [...finalOutput.matchAll(/```[\s\S]*?```/g)].map(m => m[0]);
            if (codeBlocks.length > 0) {
                 const largestBlock = codeBlocks.reduce((a, b) => a.length > b.length ? a : b);
                 const cleanCode = largestBlock.replace(/^```[a-zA-Z_-]*\n?/g, '').replace(/```$/g, '').trim();
                 if (cleanCode.length > 50) {
                     try {
                         const url = await uploadToPastebin(cleanCode);
                         if (url) finalOutput += `\n\n🔗 *Copy Code safely:* ${url}`;
                     } catch(err) { console.error("Pastebin upload failed"); }
                 }
            }
            await sock.sendMessage(chatJid, { text: finalOutput, edit: editKey });
        }

        const systemPrompt = `You are an expert AI council. ALWAYS format your output meticulously using WhatsApp markdown:
- *CRITICAL FORMATTING*: NEVER output large blocks of text. ALWAYS break everything down into very short, bite-sized paragraphs separated by double line breaks.
- *MATHEMATICS*: For ALL numerical or physics problems, solve them strictly LINE-BY-LINE. Use exact mathematical symbols (×, ÷, √, π, ∑, ∫, ≠, ≤, ≥, ², ³) and put EVERY individual step of the calculation on a brand new line. Do NOT combine multiple equation steps into a single paragraph.
- Use *bold* for headings and extreme emphasis.
- Use _italics_ for subheadings or subtle emphasis.
- Use \`\`\` (triple backticks) for all code blocks or structured data tables.
- Use \` (single backtick) for inline variables.
- Use > (blockquote) for important conclusions or highlighted facts.
- Use numbered (1., 2.) and bulleted (-) lists rigorously instead of large paragraphs.
- Weave relevant emojis gracefully but professionally to anchor visual sections.
Avoid walls of text. Provide absolute maximum intelligence, logic, and structure. DO NOT introduce yourself or state your model name. Just answer.`;

        // Push user message to history once before generating
        history.push({ role: 'user', parts: [{ text: fullPrompt }] });

        // ONE unified message for the frontend
        const sentMsg = await sock.sendMessage(chatJid, { text: `💭 _Analyzing..._` }, { quoted: msg });

        if (isImageIntent) {
            await sock.sendMessage(chatJid, { text: `🎨 _Generating your images..._` }, { edit: sentMsg.key });
            
            const tasks = [
               { provider: 'NVIDIA (SD3)', promise: generateImageNvidia(fullPrompt, 'stabilityai/stable-diffusion-3-medium') },
               { provider: 'NVIDIA (Flux)', promise: generateImageNvidia(fullPrompt, 'black-forest-labs/flux.2-klein-4b') },
               { provider: 'Gemini', promise: generateImageGemini(fullPrompt) },
            ];
            
            // Wait for all to finish, whether they succeed or fail
            const results = await Promise.allSettled(tasks.map(t => t.promise));
            
            const successes = [];
            const errors = [];
            
            results.forEach((res, index) => {
                if (res.status === 'fulfilled') {
                    successes.push({ ...tasks[index], buffer: res.value });
                } else {
                    errors.push(`${tasks[index].provider}: ${res.reason.message || res.reason}`);
                }
            });
            
            // 🚨 User requested max 2 models returning images
            const topSuccesses = successes.slice(0, 2);
            
            if (topSuccesses.length > 0) {
                 // Send all successful images sequentially (up to 2 max)
                 for (const success of topSuccesses) {
                     await sock.sendMessage(chatJid, { 
                         image: success.buffer, 
                         caption: `🎨 *Generated by ${success.provider}*` 
                     }, { quoted: msg });
                 }
                 // Delete the loading message
                 await sock.sendMessage(chatJid, { delete: sentMsg.key });
            } else {
                 // If ALL of them failed, send the error log
                 const errText = errors.join('\n');
                 await sock.sendMessage(chatJid, { text: `❌ _Failed to generate any images:_\n\n${errText}` }, { edit: sentMsg.key });
            }
            return;
        }

        if (isParallelCouncil) {
            // DRAFT + BACKGROUND PATTERN
            // 1. Run Draft (Gemini) immediately into the UI
            try {
                const draftStream = streamGenerate(fullPrompt, 'gemini-2.5-flash', systemPrompt, history.slice(0, -1));
                let draftAccumulated = '';
                let lastEditTime = 0;
                let chunkBuffer = '';
                
                for await (const chunk of draftStream) {
                    draftAccumulated += chunk;
                    chunkBuffer += chunk;
                    const now = Date.now();
                    
                    if (now - lastEditTime >= EDIT_INTERVAL && chunkBuffer.length >= MIN_CHUNK) {
                        try {
                            await sock.sendMessage(chatJid, {
                                text: streamingIndicator(formatForWhatsApp(draftAccumulated)),
                                edit: sentMsg.key
                            });
                            lastEditTime = now;
                            chunkBuffer = '';
                        } catch (e) {}
                    }
                }
                // Leave draft intact while waiting for heavy models, appending warning
                await sock.sendMessage(chatJid, {
                    text: formatForWhatsApp(draftAccumulated) + `\n\n> ⏳ _Draft response complete. The Heavy Council is computing a deep answer in the background..._`,
                    edit: sentMsg.key
                });
            } catch (e) {
                console.error("Draft failed, skipping to background execution.");
            }

            // 2. Run Heavy Models silently in background
            const bgTasks = modelConfigs.map(async (modelConfig) => {
                const { name: modelName, provider, imageBase64: img64 } = modelConfig;
                let bgAccumulated = '';
                try {
                    const stream = provider === 'nvidia'
                        ? streamGenerateNvidia(fullPrompt, modelName, systemPrompt, history.slice(0, -1), img64)
                        : streamGenerate(fullPrompt, modelName, systemPrompt, history.slice(0, -1));

                    for await (const chunk of stream) {
                        bgAccumulated += chunk; // No networking overhead, purely backgrounding
                    }
                    return { modelName, accumulated: bgAccumulated };
                } catch (err) {
                    return { modelName, accumulated: `*(Failed to run ${modelName})*` };
                }
            });

            const results = await Promise.all(bgTasks);
            
            // 3. Reveal final massive answer (replace draft)
            const combinedOutput = results.map((r, idx) => `> *Council Node ${idx+1} Analysis:*\n${r.accumulated}`).join('\n\n');
            const finalText = finalFormat(combinedOutput, 'Council');
            
            await postProcessAndSend(finalText, sentMsg.key);

            console.log(`✅ Parallel Council execution complete. Replaced draft.`);

            history.push({ role: 'model', parts: [{ text: combinedOutput }] });

        } else {
            // STANDARD SINGLE EXECUTION
            const modelConfig = modelConfigs[0];
            const { name: modelName, provider, imageBase64: img64 } = modelConfig;
            let accumulated = '';
            let lastEditTime = 0;
            let chunkBuffer = '';
            
            try {
                const stream = provider === 'nvidia'
                    ? streamGenerateNvidia(fullPrompt, modelName, systemPrompt, history.slice(0, -1), img64)
                    : streamGenerate(fullPrompt, modelName, systemPrompt, history.slice(0, -1));

                for await (const chunk of stream) {
                    accumulated += chunk;
                    chunkBuffer += chunk;

                    const now = Date.now();
                    const timeSinceLastEdit = now - lastEditTime;

                    if (timeSinceLastEdit >= EDIT_INTERVAL && chunkBuffer.length >= MIN_CHUNK) {
                        try {
                            await sock.sendMessage(chatJid, {
                                text: streamingIndicator(formatForWhatsApp(accumulated)),
                                edit: sentMsg.key
                            });
                            lastEditTime = now;
                            chunkBuffer = '';
                        } catch (editErr) {}
                    }
                }

                // Final edit WITHOUT model name
                const finalText = finalFormat(accumulated, modelName);
                await postProcessAndSend(finalText, sentMsg.key);

                console.log(`✅ Response sent (${accumulated.length} chars) via ${modelName}`);

                history.push({ role: 'model', parts: [{ text: accumulated }] });

            } catch (error) {
                console.error(`❌ Stream error from ${modelName}:`, error.message);
                const errorMsg = accumulated 
                    ? finalFormat(accumulated, modelName) + `\n\n*(Error generating the rest)*`
                    : `❌ _Error: Failed to fetch response_`;

                await sock.sendMessage(chatJid, {
                    text: errorMsg,
                    edit: sentMsg.key
                });
                history.push({ role: 'model', parts: [{ text: accumulated || 'Error' }] });
            }
        }

        // Prune history if it exceeds the limit
        if (history.length > MAX_HISTORY_LENGTH) {
            const excess = history.length - MAX_HISTORY_LENGTH;
            history.splice(0, excess);
        }

    } catch (error) {
        console.error('❌ Handler error:', error);
    }
}

// Global error handlers to prevent Baileys internal crashes (e.g., libsignal decryption failures)
process.on('unhandledRejection', (err) => {
    console.error('⚠️ Unhandled Promise Rejection (Likely Baileys Internal):', err.message || err);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught Exception:', err.message || err);
});

// Start Express Server for Render health checks and UptimeRobot pinging
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
    if (globalQR && globalQR !== 'connected') {
        const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?data=' + encodeURIComponent(globalQR) + '&size=300x300';
        res.send(`
            <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
                <h2>📱 Scan to Login to WhBot</h2>
                <img src="${qrUrl}" alt="WhatsApp QR Code" style="border: 1px solid #ccc; padding: 10px; border-radius: 10px;" />
                <p style="color: #666; margin-top: 20px;">Refresh this page if the QR code expires.</p>
            </div>
        `);
    } else if (globalQR === 'connected') {
        res.send('<h2 style="font-family: sans-serif; text-align: center; margin-top: 50px; color: green;">✅ WhBot is Connected and Running!</h2>');
    } else {
        res.send('<h2 style="font-family: sans-serif; text-align: center; margin-top: 50px;">🤖 WhBot is starting, please wait...</h2>');
    }
});

app.listen(PORT, () => {
    console.log(`🌐 Web UI server running on port ${PORT}`);
});

// Start WhatsApp Bot
console.log('🚀 Starting WhBot AI...');
startBot().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
