// ALB and container health check (#30). Like the API's /health, it names the
// commit the running image was built from, so a deploy can be confirmed from
// outside (`curl -s https://hooplings.com/health`).
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok', commit: process.env.GIT_COMMIT ?? 'unknown' });
}
