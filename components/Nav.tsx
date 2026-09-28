import Link from 'next/link';

export function Nav({ on }: { on: 'PM' | 'SPM' | 'upload' }) {
  return (
    <nav>
      <strong style={{ marginRight: 12 }}>Kargo hiring</strong>
      <Link href="/?role=PM" className={on === 'PM' ? 'on' : ''}>PM</Link>
      <Link href="/?role=SPM" className={on === 'SPM' ? 'on' : ''}>SPM</Link>
      <span className="sp" />
      <Link href="/upload" className={on === 'upload' ? 'on' : ''}>Upload CVs</Link>
    </nav>
  );
}
