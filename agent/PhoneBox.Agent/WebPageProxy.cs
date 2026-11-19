using System.Net;
using System.Text;
using Microsoft.AspNetCore.Http.Features;

namespace PhoneBox.Agent;

/// <summary>
/// Web page widget: fetches the page a widget shows for a phone that can't load it itself. The app allows plain http
/// only to the phone itself and shows the panel as a secure page, so a page on this computer
/// (http://127.0.0.1:8014/…) or on the local network reaches the phone through here, over USB and Wi-Fi alike.
/// The phone shows it under an origin of its own (https://&lt;key&gt;.pcweb.androidplatform.net, see MainActivity.webPage
/// and widgets/web.js), so the page's own requests (scripts, styles, data) come back here as well.
/// Only GET, only on the origin (scheme, host and port) of the address the widget names, and only for a Web page widget
/// on an enabled page this phone shows: the phone can't use it to reach any other address.
/// </summary>
public sealed class WebPageProxy
{
    public const string WidgetType = "webpage";
    public const string RoutePrefix = "/api/web/";
    private const int MaxRedirects = 5;
    // a widget key is "pageId/widgetId" or "pageId/stackId:cardId", hex-encoded
    private const int MaxKeyHex = 512;

    private readonly ConfigStore _config;
    private readonly HttpClient _http;

    public WebPageProxy(ConfigStore config) : this(config, new SocketsHttpHandler
    {
        AllowAutoRedirect = false, // followed here, and only on the page's own origin
        UseCookies = false,
        AutomaticDecompression = DecompressionMethods.All,
        ConnectTimeout = TimeSpan.FromSeconds(5),
    }) { }

    internal WebPageProxy(ConfigStore config, HttpMessageHandler handler)
    {
        _config = config;
        _http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(20) };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("PhoneBox/1.0 (web page widget)");
    }

    /// <summary>The widget key ("pageId/widgetId") from its hex form in the phone's address, or null.</summary>
    public static string? DecodeKey(string? hex)
    {
        if (string.IsNullOrEmpty(hex) || hex.Length > MaxKeyHex || hex.Length % 2 != 0) return null;
        try { return Encoding.UTF8.GetString(Convert.FromHexString(hex)); }
        catch (FormatException) { return null; }
    }

    /// <summary>The page's address as a widget names it, if it is an http(s) address.</summary>
    public static Uri? PageUri(string? url) =>
        Uri.TryCreate((url ?? "").Trim(), UriKind.Absolute, out var u) && u.Scheme is "http" or "https" && u.Host.Length > 0 ? u : null;

    /// <summary>
    /// The address to fetch for a path (with its query) the phone asks for on the widget's page, or null when it would
    /// leave the origin of that page.
    /// </summary>
    public static Uri? Target(string? pageUrl, string pathAndQuery)
    {
        if (PageUri(pageUrl) is not { } page) return null;
        if (string.IsNullOrEmpty(pathAndQuery)) pathAndQuery = "/";
        if (pathAndQuery[0] == '?') pathAndQuery = "/" + pathAndQuery;
        if (pathAndQuery[0] != '/') return null;
        if (!Uri.TryCreate(page.GetLeftPart(UriPartial.Authority) + pathAndQuery, UriKind.Absolute, out var target)) return null;
        return SameOrigin(page, target) ? target : null;
    }

    public static bool SameOrigin(Uri a, Uri b) =>
        a.Scheme == b.Scheme && a.Port == b.Port && string.Equals(a.IdnHost, b.IdnHost, StringComparison.OrdinalIgnoreCase);

    /// <summary>What follows /api/web/&lt;key&gt; in the request, as the phone sent it (still percent-encoded).</summary>
    internal static string RestOf(HttpRequest req, string hexKey)
    {
        var raw = req.HttpContext.Features.Get<IHttpRequestFeature>()?.RawTarget;
        if (string.IsNullOrEmpty(raw) || raw[0] != '/') raw = req.Path.ToUriComponent() + req.QueryString.ToUriComponent();
        var prefix = RoutePrefix + hexKey;
        return raw.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? raw[prefix.Length..] : "/";
    }

    public async Task Serve(HttpContext ctx, string hexKey, CancellationToken ct)
    {
        var res = ctx.Response;
        res.Headers.CacheControl = "no-store";
        var key = DecodeKey(hexKey);
        var device = ctx.Request.Headers["X-PhoneBox-Device"].ToString();
        if ((key is null ? null : PanelWidgets.Find(_config.Get(), device, key, WidgetType)) is not { } widget)
        {
            await Fail(res, 404, "This Web page widget isn't on a page this phone shows. Save the layout in PhoneBox's settings, then try again.");
            return;
        }
        var url = widget.Str("url");
        if (PageUri(url) is not { } page)
        {
            await Fail(res, 400, "Set the page's address (http://… or https://…) in the widget's settings.");
            return;
        }
        if (Target(url, RestOf(ctx.Request, hexKey)) is not { } target)
        {
            await Fail(res, 400, "That address is not on the widget's page.");
            return;
        }

        try
        {
            for (var hop = 0; ; hop++)
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, target);
                req.Headers.Accept.ParseAdd("*/*");
                using var up = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
                var code = (int)up.StatusCode;
                if (code is >= 300 and < 400 && up.Headers.Location is { } location)
                {
                    var next = new Uri(target, location);
                    if (!SameOrigin(page, next))
                    {
                        await Fail(res, 502, $"The page sends you on to {next.GetLeftPart(UriPartial.Path)}, which is on another address. Put that address in the widget instead.");
                        return;
                    }
                    if (hop >= MaxRedirects)
                    {
                        await Fail(res, 502, "The page keeps redirecting.");
                        return;
                    }
                    target = next;
                    continue;
                }
                res.StatusCode = code is >= 200 and < 600 ? code : 502;
                if (up.Content.Headers.ContentType is { } type) res.ContentType = type.ToString();
                await using var body = await up.Content.ReadAsStreamAsync(ct);
                await body.CopyToAsync(res.Body, ct);
                return;
            }
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or IOException && !ct.IsCancellationRequested)
        {
            if (!res.HasStarted)
                await Fail(res, 502, $"Couldn't reach {page.GetLeftPart(UriPartial.Authority)} from this computer. Is the program that serves the page running?");
        }
    }

    private static Task Fail(HttpResponse res, int status, string message)
    {
        res.StatusCode = status;
        res.ContentType = "text/html; charset=utf-8";
        var text = WebUtility.HtmlEncode(message);
        return res.WriteAsync($$"""
            <!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>html,body{margin:0;height:100%;background:transparent;color:#8a94a3;font:14px Roboto,"Segoe UI",system-ui,sans-serif}
            body{display:flex;align-items:center;justify-content:center;text-align:center;padding:12px;box-sizing:border-box}</style>
            <p>{{text}}</p>
            """);
    }
}
