import Link from 'next/link';

export function Nav({ on }: { on: 'home' | 'review' | 'upload' }) {
  return (
    <header className="top">
      <Link href="/" className="brand">Kargo hiring</Link>
      <nav>
        <Link href="/review" className={on === 'review' ? 'on' : ''}>Review</Link>
        <Link href="/upload" className={on === 'upload' ? 'on' : ''}>Upload</Link>
      </nav>
    </header>
  );
}
