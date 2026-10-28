import { useState } from 'react';

/** The visitor's `ml_vid` cookie value, click to copy (e.g. to look them up in your own app or the payments API). */
export function CookieId({ id, className = '' }: { id: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="ml_vid cookie (click to copy)"
      className={`inline-flex max-w-full items-center gap-1 rounded-md bg-stone-100 px-1.5 py-0.5 font-mono text-xs text-stone-600 transition hover:bg-stone-200 hover:text-ink ${className}`}
      onClick={(e) => {
        // Rows open the visitor profile on click; copying shouldn't.
        e.stopPropagation();
        navigator.clipboard.writeText(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <span className="shrink-0 text-stone-400">ml_vid</span>
      <span className="truncate">{copied ? '✓ Copied' : id}</span>
    </button>
  );
}
