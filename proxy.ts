import { NextResponse, type NextRequest } from 'next/server';

// Optional site password (HTTP Basic auth — any username, password = DASHBOARD_PASSWORD).
// With DASHBOARD_PASSWORD unset the site is open to anyone with the link — fine for the fictional case
// data used here; set it again before real candidates' details are uploaded.
export function proxy(req: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return NextResponse.next();
  const header = req.headers.get('authorization') ?? '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = atob(encoded);
    if (decoded.slice(decoded.indexOf(':') + 1) === password) return NextResponse.next();
  }
  return new NextResponse('Password required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Kargo hiring"' } });
}

export const config = { matcher: '/((?!_next/static|_next/image|favicon.ico).*)' };
