/**
 * Converts markdown-style formatting to WhatsApp-compatible formatting.
 * Preserves math symbols, emoji, and special Unicode characters.
 */

export function formatForWhatsApp(text) {
    if (!text) return '';

    let result = text;

    // Protect code blocks from formatting (store and replace later)
    const codeBlocks = [];
    result = result.replace(/```([\s\S]*?)```/g, (match) => {
        codeBlocks.push(match); // keep triple backticks as-is (WhatsApp supports them)
        return `%%CODEBLOCK_${codeBlocks.length - 1}%%`;
    });

    // Protect inline code
    const inlineCode = [];
    result = result.replace(/`([^`]+)`/g, (match) => {
        inlineCode.push(match); // keep backticks as-is
        return `%%INLINECODE_${inlineCode.length - 1}%%`;
    });

    // Convert markdown bold **text** to WhatsApp bold *text*
    // But avoid clobbering already-single-asterisk italic
    result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');

    // Convert markdown italic _text_ (underscore style) — WhatsApp uses _ too, so keep as-is
    // Convert markdown italic *text* that isn't bold — tricky, skip since we just converted bold

    // Convert markdown strikethrough ~~text~~ to WhatsApp ~text~
    result = result.replace(/~~(.+?)~~/g, '~$1~');

    // Convert markdown headers (## Header) to bold text
    result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

    // Convert markdown bullet lists (- item) to WhatsApp-friendly (• item)
    result = result.replace(/^[\s]*[-*]\s+/gm, '• ');

    // Convert numbered lists markdown style to clean format
    result = result.replace(/^(\d+)\.\s+/gm, '$1. ');

    // Clean up excessive blank lines (max 2)
    result = result.replace(/\n{4,}/g, '\n\n\n');

    // Restore code blocks
    codeBlocks.forEach((block, i) => {
        result = result.replace(`%%CODEBLOCK_${i}%%`, block);
    });

    // Restore inline code
    inlineCode.forEach((code, i) => {
        result = result.replace(`%%INLINECODE_${i}%%`, code);
    });

    return result.trim();
}

/**
 * Creates a typing indicator text for streaming display
 */
export function streamingIndicator(text) {
    return text + ' ▍';
}

/**
 * Wraps final response
 */
export function finalFormat(text, modelUsed) {
    return formatForWhatsApp(text);
}
