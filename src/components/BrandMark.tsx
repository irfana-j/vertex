// A small node graph — every tracked template is literally a graph of
// nodes, so this is the product's own concept rather than an arbitrary
// mark. Reused wherever the brand square appears (sidebar, login page);
// color comes from the parent via currentColor.
export default function BrandMark({ className }: { className?: string }) {
  return (
    <span className={className}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" xmlns="http://www.w3.org/2000/svg">
        <circle cx="5" cy="6" r="2.1" fill="currentColor" stroke="none" />
        <circle cx="19" cy="6" r="2.1" fill="currentColor" stroke="none" />
        <circle cx="12" cy="13" r="2.1" fill="currentColor" stroke="none" />
        <circle cx="12" cy="20.5" r="2.1" fill="currentColor" stroke="none" />
        <path d="M5 8.1 10.3 11.5M19 8.1 13.7 11.5M12 15.1V18.4" />
      </svg>
    </span>
  )
}
