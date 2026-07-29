export type ReviewClipItem = {
  id: string;
  label: string;
  content: string;
};

function cleanReviewClipBlock(block: string): string {
  return block
    .replace(/^##\s*\d+\s*$/gmu, "")
    .replace(/<span\b[^>]*>[\s\S]*?<\/span>/giu, "")
    .replace(/!\[[^\]]*\]\([^)\r\n]*\)/gu, "")
    .replace(/<img\b[^>]*\/?>/giu, "")
    .replace(/^\s*(?:收集于|创建于)[^\r\n]*$/gmu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseReviewClipboard(raw: string): ReviewClipItem[] {
  const blocks = raw.replace(/\r\n?/g, "\n").split(/^\s*---\s*$/gmu);
  const items: ReviewClipItem[] = [];
  blocks.forEach((block, blockIndex) => {
    const heading = block.match(/^##\s*(\d+)\s*$/mu);
    if (!heading && /^(?:#\s*复习剪贴|>\s*创建于)/mu.test(block)) return;
    const content = cleanReviewClipBlock(block);
    if (!content) return;
    const label = heading?.[1] ?? String(items.length + 1);
    items.push({
      id: `review-clip-${label}-${blockIndex}`,
      label,
      content,
    });
  });
  return items;
}
