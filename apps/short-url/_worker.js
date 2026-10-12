const destination = 'https://samjeong-moa.samjeong-moa.workers.dev';
export default {
  fetch(request) {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Use the school service address for API requests.', { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
    const source = new URL(request.url);
    const target = new URL(destination);
    target.pathname = source.pathname;
    target.search = source.search;
    return new Response(null, { status: 302, headers: { Location: target.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  },
};
