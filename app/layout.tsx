import './globals.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'Kargo hiring' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
