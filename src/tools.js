import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

import PDFDocument from 'pdfkit';
import google from 'googlethis';
import https from 'https';

/**
 * Extracts raw text from a PDF Buffer
 */
export async function parsePdfBuffer(buffer) {
    try {
        const data = await pdfParse(buffer);
        return data.text;
    } catch (err) {
        console.error('PDF Parse Error:', err);
        return 'Error: Could not read PDF.';
    }
}

/**
 * Creates a simple formatted PDF Buffer from text
 */
export async function createPdfBuffer(text) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument();
            const buffers = [];
            
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => {
                const pdfData = Buffer.concat(buffers);
                resolve(pdfData);
            });

            // Add text to document
            doc.fontSize(12).text(text, { align: 'left' });
            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Uses free dpaste API to host code blocks.
 * Returns the URL pasted.
 */
export async function uploadToPastebin(content) {
    return new Promise((resolve, reject) => {
        const data = new URLSearchParams({
            content: content,
            syntax: 'text',
            expiry_days: '7'
        }).toString();

        const options = {
            hostname: 'dpaste.com',
            path: '/api/v2/',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(data),
                'User-Agent': 'WhBot-AI-Assistant'
            }
        };

        const req = https.request(options, (res) => {
            let resData = '';
            res.on('data', chunk => resData += chunk);
            res.on('end', () => {
                const url = resData.trim();
                resolve(url.startsWith('http') ? url : null);
            });
        });

        req.on('error', (e) => reject(e));
        req.write(data);
        req.end();
    });
}

/**
 * Perform a web search and return top 3 snippets combined
 */
export async function googleSearch(query) {
    try {
        const options = {
            page: 0, 
            safe: false, 
            additional_params: { hl: 'en' }
        };
        const response = await google.search(query, options);
        
        if (!response.results.length) return "No results found on Google.";

        // Grab top 3 results
        const topResults = response.results.slice(0, 3).map((r, i) => {
            return `Result ${i+1}:\nTitle: ${r.title}\nSnippet: ${r.description}`;
        }).join('\n\n');

        return topResults;
    } catch (err) {
        console.error("Google search error:", err);
        return "Search failed due to an error.";
    }
}
