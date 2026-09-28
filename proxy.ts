import { NextResponse, type NextRequest } from 'next/server';

// The dashboard holds candidates' personal details and can send email, so the whole site sits
// behind one password (HTTP Basic auth — any username, password = DASHBOARD_PASSWORD).
export function proxy(req: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) {
    if (process.env.NODE_ENV !== 'production') return NextResponse.next();
    return new NextResponse('Locked: set DASHBOARD_PASSWORD in Vercel environment variables, then redeploy.', { status: 503 });
  }
  const header = req.headers.get('authorization') ?? '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = atob(encoded);
    if (decoded.slice(decoded.indexOf(':') + 1) === password) return NextResponse.next();
  }
  return new NextResponse('Password required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Kargo hiring"' } });
}

export const config = { matcher: '/((?!_next/static|_next/image|favicon.ico).*)' };
