import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import makeWASocket, { DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import { getAuthState } from './store.js';
import { streamGenerate, config } from './gemini.js';
import { selectModel, analyzeIntent } from './router.js';
import { fetchNvidiaModels, streamGenerateNvidia, fuzzyMatchModel, availableModels } from './nvidia.js';
import { runCouncil } from './council.js';
import { formatForWhatsApp, streamingIndicator, finalFormat } from './formatter.js';
import express from 'express';
import { parsePdfBuffer, createPdfBuffer, uploadToPastebin, googleSearch } from './tools.js';

const logger = pino({ level: 'silent' });

const PREFIX = config.commandPrefix || '.ask';
const EDIT_INTERVAL = config.streaming?.editIntervalMs || 600;
const MIN_CHUNK = config.streaming?.minChunkLength || 8;
const MAX_HISTORY_LENGTH = 20;
const MESSAGE_CACHE_TTL = 10 * 60 * 1000;
const MAX_TRACKED_MESSAGES = 500;

const chatHistories = new Map();
const processedMessages = new Map();
const botMessageIds = new Map();

let START_TIME = Math.floor(Date.now() / 1000);
let botReady = false;
let globalQR = null;
let isReconnecting = false;
let shuttingDown = false;
let reconnectTimer = null;
let reconnectAttempts = 0;

let sock;
let myJid = null;

function pruneMessageMap(map) {
    const now = Date.now();
    for (const [id, ts] of map.entries()) {
        if (now - ts > MESSAGE_CACHE_TTL) {
            map.delete(id);
        }
    }
    while (map.size > MAX_TRACKED_MESSAGES) {
        const oldestKey = map.keys().next().value;
        if (!oldestKey) break;
        map.delete(oldestKey);
    }
}

function rememberMessage(map, messageId) {
    if (!messageId) return;
    pruneMessageMap(map);
    map.set(messageId, Date.now());
}

function hasRecentMessage(map, messageId) {
    if (!messageId) return false;
    pruneMessageMap(map);
    return map.has(messageId);
}

function getMessageId(message) {
    return message?.key?.id || message?.key?.remoteJid + ':' + Number(message?.messageTimestamp || 0);
}

function rememberBotMessage(sentMessage) {
    const messageId = getMessageId(sentMessage);
    if (messageId) {
        rememberMessage(botMessageIds, messageId);
    }
}

async function sendBotMessage(jid, content, options = {}) {
    const sent = await sock.sendMessage(jid, content, options);
    rememberBotMessage(sent);
    return sent;
}

async function updateOrSendText(jid, text, editKey, options = {}) {
    if (editKey) {
        try {
            await sock.sendMessage(jid, { text, edit: editKey });
            return { key: editKey, edited: true };
        } catch (error) {
            console.warn('Message edit failed, sending a fresh fallback message:', error?.message || error);
        }
    }

    const sent = await sendBotMessage(jid, { text }, options);
    return { key: sent.key, edited: false };
}

async function startBot() {
    if (shuttingDown) {
        console.log('Shutdown in progress, skipping bot start.');
        return;
    }

    if (isReconnecting) {
        console.log('Reconnection already in progress, skipping duplicate...');
        return;
    }
    isReconnecting = true;

    try {
        if (sock) {
            try {
                sock.ev.removeAllListeners();
                sock.ws?.close();
            } catch (e) {}
            sock = null;
        }
        botReady = false;

        await fetchNvidiaModels();
        const { state, saveCreds } = await getAuthState();
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                globalQR = qr;
                const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(qr);
                console.log('\n\nWhBot AI - QR Login\n');
                console.log(qrUrl + '\n');
            }

            if (connection === 'open') {
                isReconnecting = false;
                reconnectAttempts = 0;
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = null;
                }
                globalQR = 'connected';
                myJid = sock.user?.id;
                botReady = true;
                START_TIME = Math.floor(Date.now() / 1000);
                console.log(`Connected as ${sock.user?.name || 'Unknown'} (${myJid || ''})`);
                console.log('Listening for messages...');
            }

            if (connection === 'close') {
                botReady = false;
                if (shuttingDown) {
                    isReconnecting = false;
                    return;
                }

                const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== DisconnectReason.badSession;

                console.log(`Disconnected. Status: ${statusCode}`);

                if (shouldReconnect) {
                    isReconnecting = false;
                    reconnectAttempts += 1;
                    const baseDelay = statusCode === DisconnectReason.connectionReplaced || statusCode === 440 ? 15000 : 3000;
                    const cappedDelay = Math.min(baseDelay * (2 ** Math.min(reconnectAttempts - 1, 4)), 120000);
                    const jitter = Math.floor(Math.random() * 2000);
                    const delay = cappedDelay + jitter;

                    if (statusCode === DisconnectReason.connectionReplaced || statusCode === 440) {
                        console.log('Connection replaced detected (often duplicate instance/session).');
                    }

                    console.log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);
                    if (reconnectTimer) clearTimeout(reconnectTimer);
                    reconnectTimer = setTimeout(() => {
                        reconnectTimer = null;
                        startBot();
                    }, delay);
                } else {
                    isReconnecting = false;
                    if (statusCode === DisconnectReason.badSession) {
                        console.log('Bad session detected. Clear auth state and login again.');
                    } else {
                        console.log('Logged out. Delete auth_info/ folder and restart to re-login.');
                    }
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (!botReady) return;
            if (type !== 'notify') return;

            for (const msg of messages) {
                const messageId = getMessageId(msg);
                if (messageId && hasRecentMessage(botMessageIds, messageId)) {
                    continue;
                }
                if (messageId && hasRecentMessage(processedMessages, messageId)) {
                    continue;
                }
                rememberMessage(processedMessages, messageId);
                await handleMessage(msg);
            }
        });
    } catch (err) {
        console.error('startBot error:', err.message);
        isReconnecting = false;
        if (!shuttingDown) {
            reconnectAttempts += 1;
            const delay = Math.min(5000 * (2 ** Math.min(reconnectAttempts - 1, 4)), 120000);
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                startBot();
            }, delay);
        }
    }
}

async function handleMessage(msg) {
    try {
        if (!msg?.message) return;

        const incomingId = getMessageId(msg);
        if (incomingId && hasRecentMessage(botMessageIds, incomingId)) return;
        if (!msg.key.fromMe) return;

        let msgTime = Number(msg.messageTimestamp);
        if (typeof msg.messageTimestamp === 'object') {
            if (typeof msg.messageTimestamp.toNumber === 'function') {
                msgTime = msg.messageTimestamp.toNumber();
            } else if ('low' in msg.messageTimestamp) {
                msgTime = msg.messageTimestamp.low;
            }
        }

        if (msgTime > 10000000000) {
            msgTime = Math.floor(msgTime / 1000);
        }

        if (msgTime < START_TIME) return;

        const text = msg.message?.conversation
            || msg.message?.extendedTextMessage?.text
            || '';

        const msgType = Object.keys(msg.message || {})[0];
        const quotedMessage = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const isImage = msgType === 'imageMessage' || quotedMessage?.imageMessage;
        const isDoc = msgType === 'documentMessage' || quotedMessage?.documentMessage;
        const chatJid = msg.key.remoteJid;

        let imageBase64 = null;
        if (isImage) {
            const mediaNode = msgType === 'imageMessage' ? msg : { ...msg, message: quotedMessage };
            try {
                const buffer = await downloadMediaMessage(mediaNode, 'buffer', {}, { logger });
                imageBase64 = buffer.toString('base64');
            } catch (e) {
                console.error('Image download failed', e);
            }
        }

        let pdfContext = '';
        if (isDoc) {
            const mediaNode = msgType === 'documentMessage' ? msg : { ...msg, message: quotedMessage };
            if (mediaNode.message.documentMessage?.mimetype === 'application/pdf') {
                try {
                    const buffer = await downloadMediaMessage(mediaNode, 'buffer', {}, { logger });
                    pdfContext = await parsePdfBuffer(buffer);
                    if (pdfContext) {
                        pdfContext = `[Extracted PDF Content:\n${pdfContext.substring(0, 15000)}]\n\n`;
                    }
                } catch (e) {
                    console.error('PDF Parse failed', e);
                }
            }
        }

        if (text.trim() === '.help') {
            const helpMenu = `*WhBot Council - Tool Suite*\n\n`
                + `*Core Chat:*\n`
                + `• \`.ask <msg>\` - Talk to the AI router\n`
                + `• \`.ask "model" <msg>\` - Force a specific model\n`
                + `• \`.council <msg>\` - Deploy the 9-Member AI Council\n`
                + `• \`.model\` - List all available models\n\n`
                + `*Tools:*\n`
                + `• \`.search <query>\` - Perform a live Google search\n`
                + `• \`.topdf <text>\` - Converts your text into a PDF file\n\n`
                + `*Auto-Features:*\n`
                + `• Vision: Send any image with a caption to analyze it via Llama-90B.\n`
                + `• PDF Reader: Send any PDF file with a prompt to read it.\n`
                + `• Code Export: Any large code output will automatically generate a Pastebin link for easy copying.`;
            await sendBotMessage(chatJid, { text: helpMenu });
            return;
        }

        if (text.startsWith('.topdf ')) {
            const pdfInput = text.substring(7);
            await sendBotMessage(chatJid, { text: 'Processing PDF...' }, { quoted: msg });
            try {
                const pBuffer = await createPdfBuffer(pdfInput);
                await sendBotMessage(chatJid, {
                    document: pBuffer,
                    mimetype: 'application/pdf',
                    fileName: 'WhBot_Generated.pdf'
                });
            } catch (e) {
                await sendBotMessage(chatJid, { text: 'PDF generation failed.' });
            }
            return;
        }

        if (text.trim() === '.model') {
            const availableModelsMsg = `*Available AI Models*\n\n`
                + `*Quick Reference (Tiers):*\n`
                + `• Tier 1: ${config.models.tier1.map(m => m.name).join(', ')}\n`
                + `• Tier 2: ${config.models.tier2.map(m => m.name).join(', ')}\n`
                + `• Tier 3 (Council): ${config.models.tier3.map(m => m.name).join(', ')}\n\n`
                + `*All Available NVIDIA NIMs:*\n`
                + (availableModels.length ? `\`\`\`${availableModels.join('\n')}\`\`\`` : '_(Loading...)_') + `\n\n`
                + `_Use '.ask "model_name" your prompt' to force a specific model. You do not need to type the full name, just enough words to fuzzy match it!_`;
            await sendBotMessage(chatJid, { text: availableModelsMsg });
            return;
        }

        let prompt = '';
        let isSelect = false;
        let forcedModelName = '';
        let requiresSearch = false;
        let isCouncil = false;

        if (text.startsWith('.search ')) {
            prompt = text.substring(8).trim();
            requiresSearch = true;
        } else if (text.startsWith('.council ')) {
            prompt = text.substring(9).trim();
            isCouncil = true;
        } else if (text.trim() === '.council') {
            await sendBotMessage(chatJid, { text: 'Please provide a prompt after .council.' }, { quoted: msg });
            return;
        } else if (text.startsWith(PREFIX + ' ') || text.startsWith(PREFIX + '"')) {
            const escapedPrefix = PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const match = text.match(new RegExp(`^${escapedPrefix}\\s+"([^"]+)"\\s+(.+)$`, 's'));
            if (match) {
                isSelect = true;
                forcedModelName = match[1];
                prompt = match[2].trim();
            } else {
                prompt = text.substring(PREFIX.length + 1).trim();
            }
        } else if ((isImage || isDoc) && text.trim().length > 0) {
            prompt = text.trim();
        } else {
            return;
        }

        if (!prompt && !isCouncil) return;

        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const quotedText = contextInfo?.quotedMessage?.conversation
            || contextInfo?.quotedMessage?.extendedTextMessage?.text
            || contextInfo?.quotedMessage?.imageMessage?.caption
            || contextInfo?.quotedMessage?.videoMessage?.caption
            || '';

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

        console.log(`\nPrompt: "${fullPrompt.substring(0, 80)}${fullPrompt.length > 80 ? '...' : ''}"\nChat: ${chatJid}`);

        if (!chatHistories.has(chatJid)) {
            chatHistories.set(chatJid, []);
        }
        const history = chatHistories.get(chatJid);

        let modelConfigs = [];
        let isImageIntent = false;

        if (imageBase64) {
            console.log('Vision mode activated: Overriding router to Llama-3.2-90B-Vision');
            modelConfigs = [{ provider: 'nvidia', name: 'meta/llama-3.2-90b-vision-instruct', imageBase64 }];
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
                    await sendBotMessage(chatJid, { text: `Could not find a model matching "${forcedModelName}".` });
                    return;
                }
            }
        } else {
            isImageIntent = await analyzeIntent(fullPrompt);
            if (isImageIntent) {
                console.log('Image Generation Intent Detected: Routing to Gemini 2.5 Flash Image');
                modelConfigs = [{ provider: 'gemini_image', name: 'gemini-2.5-flash-image' }];
            } else {
                modelConfigs = await selectModel(fullPrompt);
            }
        }

        const isParallelCouncil = modelConfigs.length > 1;

        history.push({ role: 'user', parts: [{ text: fullPrompt }] });

        const systemPrompt = `You are an expert AI council. ALWAYS format your output meticulously using WhatsApp markdown:
- CRITICAL FORMATTING: NEVER output large blocks of text. ALWAYS break everything down into very short, bite-sized paragraphs separated by double line breaks.
- MATHEMATICS: For ALL numerical or physics problems, solve them strictly LINE-BY-LINE. Use exact mathematical symbols (×, ÷, √, π, ∑, ∫, ≠, ≤, ≥, ², ³) and put EVERY individual step of the calculation on a brand new line. Do NOT combine multiple equation steps into a single paragraph.
- Use *bold* for headings and extreme emphasis.
- Use _italics_ for subheadings or subtle emphasis.
- Use triple backticks for all code blocks or structured data tables.
- Use single backticks for inline variables.
- Use > for important conclusions or highlighted facts.
- Use numbered (1., 2.) and bulleted (-) lists rigorously instead of large paragraphs.
Avoid walls of text. Provide absolute maximum intelligence, logic, and structure. DO NOT introduce yourself or state your model name. Just answer.`;

        const sentMsg = await sendBotMessage(chatJid, { text: 'Analyzing...' }, { quoted: msg });
        let activeReplyKey = sentMsg.key;

        const updateReplyText = async (textToSend) => {
            const result = await updateOrSendText(chatJid, textToSend, activeReplyKey, { quoted: msg });
            if (result?.key) {
                activeReplyKey = result.key;
            }
        };

        const postProcessAndSend = async (finalText) => {
            let finalOutput = finalText;
            const codeBlocks = [...finalOutput.matchAll(/```[\s\S]*?```/g)].map(m => m[0]);
            if (codeBlocks.length > 0) {
                const largestBlock = codeBlocks.reduce((a, b) => a.length > b.length ? a : b);
                const cleanCode = largestBlock.replace(/^```[a-zA-Z_-]*\n?/g, '').replace(/```$/g, '').trim();
                if (cleanCode.length > 50) {
                    try {
                        const url = await uploadToPastebin(cleanCode);
                        if (url) finalOutput += `\n\nLink: *Copy Code safely:* ${url}`;
                    } catch (err) {
                        console.error('Pastebin upload failed', err?.message || err);
                    }
                }
            }
            await updateReplyText(finalOutput);
        };

        if (isCouncil) {
            try {
                const result = await runCouncil(fullPrompt, imageBase64, async (statusMsg) => {
                    await updateReplyText(statusMsg);
                });
                history.push({ role: 'model', parts: [{ text: result.text }] });
                await postProcessAndSend(result.text);
            } catch (error) {
                console.error('Council error:', error);
                await updateReplyText(`Council Execution Failed:\n\n${error.message}`);
            }
            return;
        }

        if (isImageIntent) {
            await updateReplyText('Generating your image...');
            try {
                const response = await fetch('https://image-gen.merajrabbani-4870.workers.dev/', {
                    method: 'POST',
                    headers: {
                        Authorization: 'Bearer imagenmeraj',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ prompt: fullPrompt })
                });

                if (!response.ok) {
                    throw new Error(`Cloudflare error: ${response.status} ${response.statusText}`);
                }

                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                await sendBotMessage(chatJid, {
                    image: buffer,
                    caption: 'Generated by Cloudflare'
                }, { quoted: msg });

                try {
                    await sock.sendMessage(chatJid, { delete: activeReplyKey });
                } catch (deleteErr) {
                    console.warn('Failed to delete progress message:', deleteErr?.message || deleteErr);
                }
            } catch (error) {
                console.error('Cloudflare Image Error:', error);
                await updateReplyText(`Failed to generate image:\n\n${error.message}`);
            }
            return;
        }

        if (isParallelCouncil) {
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
                        await updateReplyText(streamingIndicator(formatForWhatsApp(draftAccumulated)));
                        lastEditTime = now;
                        chunkBuffer = '';
                    }
                }

                await updateReplyText(formatForWhatsApp(draftAccumulated) + '\n\n> Draft response complete. The Heavy Council is computing a deep answer in the background...');
            } catch (e) {
                console.error('Draft failed, skipping to background execution.', e?.message || e);
            }

            const bgTasks = modelConfigs.map(async (modelConfig) => {
                const { name: modelName, provider, imageBase64: img64 } = modelConfig;
                let bgAccumulated = '';
                try {
                    const stream = provider === 'nvidia'
                        ? streamGenerateNvidia(fullPrompt, modelName, systemPrompt, history.slice(0, -1), img64)
                        : streamGenerate(fullPrompt, modelName, systemPrompt, history.slice(0, -1));

                    for await (const chunk of stream) {
                        bgAccumulated += chunk;
                    }
                    return { modelName, accumulated: bgAccumulated };
                } catch (err) {
                    return { modelName, accumulated: `*(Failed to run ${modelName})*` };
                }
            });

            const results = await Promise.all(bgTasks);
            const combinedOutput = results.map((r, idx) => `> *Council Node ${idx + 1} Analysis:*\n${r.accumulated}`).join('\n\n');
            const finalText = finalFormat(combinedOutput, 'Council');
            await postProcessAndSend(finalText);
            console.log('Parallel Council execution complete. Replaced draft.');
            history.push({ role: 'model', parts: [{ text: combinedOutput }] });
        } else {
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
                        await updateReplyText(streamingIndicator(formatForWhatsApp(accumulated)));
                        lastEditTime = now;
                        chunkBuffer = '';
                    }
                }

                const finalText = finalFormat(accumulated, modelName);
                await postProcessAndSend(finalText);
                console.log(`Response sent (${accumulated.length} chars) via ${modelName}`);
                history.push({ role: 'model', parts: [{ text: accumulated }] });
            } catch (error) {
                console.error(`Stream error from ${modelName}:`, error.message);
                const errorMsg = accumulated
                    ? finalFormat(accumulated, modelName) + '\n\n*(Error generating the rest)*'
                    : 'Error: Failed to fetch response';
                await updateReplyText(errorMsg);
                history.push({ role: 'model', parts: [{ text: accumulated || 'Error' }] });
            }
        }

        if (history.length > MAX_HISTORY_LENGTH) {
            const excess = history.length - MAX_HISTORY_LENGTH;
            history.splice(0, excess);
        }
    } catch (error) {
        console.error('Handler error:', error);
    }
}

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Promise Rejection (Likely Baileys Internal):', err.message || err);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message || err);
});

function gracefulShutdown(signal) {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    shuttingDown = true;
    botReady = false;
    isReconnecting = false;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    try {
        sock?.ev?.removeAllListeners();
        sock?.ws?.close();
    } catch (e) {}
    setTimeout(() => process.exit(0), 250);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
    if (globalQR && globalQR !== 'connected') {
        const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?data=' + encodeURIComponent(globalQR) + '&size=300x300';
        res.send(`
            <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
                <h2>Scan to Login to WhBot</h2>
                <img src="${qrUrl}" alt="WhatsApp QR Code" style="border: 1px solid #ccc; padding: 10px; border-radius: 10px;" />
                <p style="color: #666; margin-top: 20px;">Refresh this page if the QR code expires.</p>
            </div>
        `);
    } else if (globalQR === 'connected') {
        res.send('<h2 style="font-family: sans-serif; text-align: center; margin-top: 50px; color: green;">WhBot is Connected and Running!</h2>');
    } else {
        res.send('<h2 style="font-family: sans-serif; text-align: center; margin-top: 50px;">WhBot is starting, please wait...</h2>');
    }
});

app.listen(PORT, () => {
    console.log(`Web UI server running on port ${PORT}`);
});

console.log('Starting WhBot AI...');
startBot().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
