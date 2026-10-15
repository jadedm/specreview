// Every call to GitHub's API. GitHub answers a renamed or transferred repo or
// a transferred issue with a redirect; following one would send the token
// and the request somewhere the config does not name. A redirect is never
// followed and reads as a failure (502, its message naming the status only),
// never as a 404: a 404 means done for a label removal and "not installed"
// for an app lookup, which a redirect is not.
export const API = 'https://api.github.com';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const REDIRECTED = 'x-specreview-redirect';

export const githubFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
  const res = await fetch(url, { ...init, redirect: 'manual' });
  if (!REDIRECTS.has(res.status)) return res;
  await res.body?.cancel();
  return new Response(JSON.stringify({ message: `GitHub answered with a redirect (${res.status})` }), {
    status: 502,
    headers: { 'content-type': 'application/json', [REDIRECTED]: String(res.status) },
  });
};

// The redirect status a githubFetch answer stands for, if it stands for one.
export const redirectOf = (res: Response) => res.headers.get(REDIRECTED);
