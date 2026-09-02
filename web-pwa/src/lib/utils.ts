import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * First <img> in a rich-text HTML string (e.g. the picture-description prompt).
 * Lets the recorder modals show the picture the participant is describing.
 */
export function firstImage(html: string): { src: string; alt: string } | null {
  const img = new DOMParser().parseFromString(html, 'text/html').querySelector('img');
  const src = img?.getAttribute('src');
  return src ? { src, alt: img?.getAttribute('alt') ?? '' } : null;
}
