import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Video Watermark Remover | Free Online Tool',
  description: 'Remove watermarks from videos and convert to 9:16 portrait format. 100% free, runs entirely in your browser. No uploads to any server.',
  keywords: ['watermark remover', 'video editor', '9:16 converter', 'portrait video', 'free tool'],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-surface text-white font-['Inter',sans-serif] antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
