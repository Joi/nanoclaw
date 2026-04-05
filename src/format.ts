/**
 * Format conversion for channel-specific output.
 * Claude outputs standard Markdown; each channel needs its own format.
 */

// --- Slack ---

/**
 * Convert Markdown to Slack mrkdwn format.
 * - **bold** → *bold*
 * - [text](url) → <url|text>
 * - # Heading → *Heading*
 * - Inline code and code blocks pass through (same syntax).
 */
export function markdownToSlack(md: string): string {
  let text = md;

  // Preserve code blocks (```...```) by replacing with placeholders
  const codeBlocks: string[] = [];
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Preserve inline code (`...`)
  const inlineCode: string[] = [];
  text = text.replace(/`[^`]+`/g, (match) => {
    inlineCode.push(match);
    return `\x00IC${inlineCode.length - 1}\x00`;
  });

  // **bold** or __bold__ → *bold*
  text = text.replace(/\*\*(.+?)\*\*/g, '*$1*');
  text = text.replace(/__(.+?)__/g, '*$1*');

  // [text](url) → <url|text>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // # Heading → *Heading* (bold, since Slack has no headings)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Restore inline code
  text = text.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCode[parseInt(i)]);

  // Restore code blocks
  text = text.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i)]);

  return text;
}

// --- Signal ---

/**
 * Structured result for Signal: plain text + body-range styles.
 * signal-cli 0.14.1 supports --text-style with syntax start:length:STYLE
 * (UTF-16 code units). JSON-RPC param name: textStyle.
 */
export interface SignalFormatted {
  text: string;
  textStyles: string[]; // e.g. ["0:5:BOLD", "10:3:ITALIC"]
}

/**
 * Convert Markdown to Signal body-range formatted message.
 * Strips Markdown syntax and produces style ranges for signal-cli.
 * Supported styles: BOLD, ITALIC, MONOSPACE, STRIKETHROUGH.
 */
export function markdownToSignal(md: string): SignalFormatted {
  let text = md;
  const styles: string[] = [];

  // Helper: find pattern matches, strip markers, record style.
  // After each replacement the string shrinks, so we reset lastIndex.
  function extract(re: RegExp, style: string) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const content = m[1];
      const start = m.index;
      text = text.slice(0, start) + content + text.slice(start + m[0].length);
      styles.push(`${start}:${content.length}:${style}`);
      re.lastIndex = 0; // text changed, must restart
    }
  }

  // Order matters: code blocks first (greedy), then inline, then bold before italic.

  // 1. Fenced code blocks: ```lang\n...\n``` → content as MONOSPACE
  extract(/```(?:\w*\n)?([\s\S]*?)```/g, 'MONOSPACE');

  // 2. Inline code: `...` → MONOSPACE
  extract(/`([^`]+)`/g, 'MONOSPACE');

  // 3. Bold: **...** → BOLD
  extract(/\*\*(.+?)\*\*/g, 'BOLD');

  // 4. Bold: __...__ → BOLD
  extract(/__(.+?)__/g, 'BOLD');

  // 5. Italic: *...* → ITALIC (runs after bold ** is stripped)
  extract(/(?<!\w)\*([^*]+)\*(?!\w)/g, 'ITALIC');

  // 6. Strikethrough: ~~...~~ → STRIKETHROUGH
  extract(/~~(.+?)~~/g, 'STRIKETHROUGH');

  // 7. Links: [text](url) → text (url) — no style
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // 8. Headings: # ... → BOLD (strip the hash prefix)
  {
    const headingRe = /^#{1,6}\s+(.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = headingRe.exec(text)) !== null) {
      const content = m[1];
      const start = m.index;
      text = text.slice(0, start) + content + text.slice(start + m[0].length);
      styles.push(`${start}:${content.length}:BOLD`);
      headingRe.lastIndex = 0;
    }
  }

  return { text, textStyles: styles };
}
