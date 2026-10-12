import { useReveal } from '../lib/hooks.js';

/**
 * The one card surface used everywhere below the hero: 4% white fill, 1px hairline border,
 * 20px backdrop blur, 18px radius — plus the reveal-on-scroll stagger, which is why `index`
 * (the card's position in its group) is a prop rather than a wrapper component.
 */
export default function GlassCard({ as: Tag = 'div', index = 0, className = '', children, style, ...rest }) {
  const reveal = useReveal(index);
  return (
    <Tag
      {...rest}
      ref={reveal.ref}
      style={{ ...reveal.style, ...style }}
      // min-w-0 lets a card shrink inside its grid track; without it the truncating rows inside
      // (Today's classes) size the track to their content and the whole page gains a scrollbar.
      className={`glass min-w-0 ${reveal.className} ${className}`}
    >
      {children}
    </Tag>
  );
}
