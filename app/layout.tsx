import './globals.css';
import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';

const sans = Inter({ subsets: ['latin'], variable: '--font-sans' });

export const metadata = { title: 'Kargo hiring' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={sans.variable}>
      <body>{children}</body>
    </html>
  );
}
