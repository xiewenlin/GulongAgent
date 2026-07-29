import app from "../server/app.js";

export default {
  fetch(request) {
    const url = new URL(request.url);
    const path = url.searchParams.get("_platform_path");
    if (!path || path.includes("..") || path.startsWith("/")) {
      return new Response(JSON.stringify({ code: "NOT_FOUND", message: "接口不存在" }), {
        status: 404,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    url.pathname = `/api/${path}`;
    url.searchParams.delete("_platform_path");
    return app.fetch(new Request(url, request));
  },
};
