import { USER } from '../core/manager.js';

/**
 * Extract user and character names from chat with fallbacks.
 * Returns:
 *  {
 *    userName: string | null,              // primary user name (context or first detected)
 *    charName: string | null,              // primary character name (context or first detected)
 *    userAliases: string[],                // all distinct user speaker labels detected
 *    charAliases: string[],                // all distinct character speaker labels detected
 *    sourceCounts: { user: number, char: number } // occurrences counted by speaker label
 *  }
 */
export function extractUserAndCharNames(chatArr = null) {
    const ctx = USER.getContext?.() || {};
    const chat = Array.isArray(chatArr) ? chatArr : (ctx.chat || []);

    // Primary from context (preferred)
    let userName = ctx.name1 || null;
    let charName = ctx.name2 || null;

    // Collect aliases from explicit message.name fields first
    const userAliases = new Set();
    const charAliases = new Set();

    // Regex to detect speaker labels at line starts: "Alice:", "Bob -", "Alice—", "Alice —"
    const speakerRegex = /^\s*([A-Za-z][\w]{0,31})\s*[:\-—]/;

    // Count occurrences for heuristic fallback selection
    const sourceCounts = { user: 0, char: 0 };

    for (const m of chat) {
        if (!m) continue;
        const nameField = (m.name || '').trim();
        if (m.is_user === true) {
            if (nameField) userAliases.add(nameField);
            sourceCounts.user++;
            if (!userName && nameField) userName = nameField;
        } else {
            if (nameField) charAliases.add(nameField);
            sourceCounts.char++;
            if (!charName && nameField) charName = nameField;
        }

        // Secondary: parse content lines for speaker labels
        const body = (m.mes ?? m.content ?? '').split('\n');
        for (const line of body) {
            const match = speakerRegex.exec(line);
            if (match) {
                const label = match[1];
                // Heuristic: if message is user -> userAliases; else charAliases
                if (m.is_user === true) userAliases.add(label);
                else charAliases.add(label);
            }
        }
    }

    // Final fallback if still missing: pick first alias collections
    if (!userName && userAliases.size) userName = [...userAliases][0];
    if (!charName && charAliases.size) charName = [...charAliases][0];

    return {
        userName,
        charName,
        userAliases: [...userAliases],
        charAliases: [...charAliases],
        sourceCounts
    };
}

/**
 * Convenience accessor that always works off current context chat.
 */
export function getCurrentChatNames() {
    return extractUserAndCharNames();
}

// Optional: expose globally for console debugging
window.getCurrentChatNames = getCurrentChatNames;