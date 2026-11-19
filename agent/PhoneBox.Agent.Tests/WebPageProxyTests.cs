using System.Net;
using System.Text;
using Microsoft.AspNetCore.Http;
using PhoneBox.Agent;
using Xunit;

/// <summary>Web page widget: the agent fetches only the widget's own page origin, only for a saved widget, GET only.</summary>
public sealed class WebPageProxyTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), $"phonebox-webpage-{Guid.NewGuid():N}.json");
    private readonly FakeSite _site = new();

    public void Dispose() { try { File.Delete(_path); File.Delete(_path + ".bak"); } catch { } }

    private static string Hex(string key) => Convert.ToHexString(Encoding.UTF8.GetBytes(key)).ToLowerInvariant();

    private WebPageProxy Make(string url = "http://127.0.0.1:8014/Current-Weather", bool enabled = true)
    {
        // a second, enabled page: a config whose pages are all off would get one turned back on
        File.WriteAllText(_path, $$"""
            { "pages": [ { "id": "other", "title": "Other", "widgets": [] }, { "id": "p", "title": "P", "enabled": {{(enabled ? "true" : "false")}}, "widgets": [
                { "id": "web", "type": "webpage", "x": 0, "y": 0, "w": 6, "h": 4, "options": { "url": "{{url}}" } },
                { "id": "img", "type": "image", "x": 6, "y": 0, "w": 6, "h": 4, "options": { "url": "{{url}}" } } ] } ] }
            """);
        return new WebPageProxy(new ConfigStore(_path), _site);
    }

    private static DefaultHttpContext Request(string pathAndQuery)
    {
        var ctx = new DefaultHttpContext();
        var q = pathAndQuery.IndexOf('?');
        ctx.Request.Path = q < 0 ? pathAndQuery : pathAndQuery[..q];
        if (q >= 0) ctx.Request.QueryString = new QueryString(pathAndQuery[q..]);
        ctx.Response.Body = new MemoryStream();
        return ctx;
    }

    private static string Body(HttpContext ctx)
    {
        ctx.Response.Body.Position = 0;
        return new StreamReader(ctx.Response.Body).ReadToEnd();
    }

    private async Task<HttpContext> Get(WebPageProxy proxy, string key, string rest)
    {
        var hex = Hex(key);
        var ctx = Request(WebPageProxy.RoutePrefix + hex + rest);
        await proxy.Serve(ctx, hex, default);
        return ctx;
    }

    [Theory]
    [InlineData("/Current-Weather", "http://127.0.0.1:8014/Current-Weather")]
    [InlineData("/css/site.css?v=2", "http://127.0.0.1:8014/css/site.css?v=2")]
    [InlineData("", "http://127.0.0.1:8014/")]
    [InlineData("?x=1", "http://127.0.0.1:8014/?x=1")]
    // a doubled slash stays a path on the same host, never a new host
    [InlineData("//evil.example/x", "http://127.0.0.1:8014//evil.example/x")]
    public void PathsStayOnThePagesOrigin(string rest, string expected)
    {
        Assert.Equal(expected, WebPageProxy.Target("http://127.0.0.1:8014/Current-Weather", rest)?.AbsoluteUri);
    }

    [Theory]
    [InlineData("@evil.example/")]
    [InlineData("evil.example/")]
    public void PathsThatCouldNameAnotherHostAreRefused(string rest)
    {
        Assert.Null(WebPageProxy.Target("http://127.0.0.1:8014/", rest));
    }

    [Theory]
    [InlineData("")]
    [InlineData("ftp://127.0.0.1/")]
    [InlineData("file:///C:/Windows/win.ini")]
    [InlineData("javascript:alert(1)")]
    [InlineData("127.0.0.1:8014")]
    public void OnlyHttpPagesAreFetched(string url)
    {
        Assert.Null(WebPageProxy.Target(url, "/"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("abc")]
    [InlineData("zz")]
    public void BadKeysAreRejected(string hex) => Assert.Null(WebPageProxy.DecodeKey(hex));

    [Fact]
    public void KeysRoundTrip() => Assert.Equal("p/stack:card-1", WebPageProxy.DecodeKey(Hex("p/stack:card-1")));

    [Fact]
    public void TheWebPathIsAllowedOverWifi() => Assert.True(Lan.AllowedOverLan(new PathString("/api/web/7022/x")));

    [Fact]
    public async Task ThePageAndItsFilesAreFetched()
    {
        _site.Reply = _ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("<h1>72°F</h1>", Encoding.UTF8, "text/html"),
        };
        var ctx = await Get(Make(), "p/web", "/data/now.json?u=f");
        Assert.Equal(200, ctx.Response.StatusCode);
        Assert.Equal("<h1>72°F</h1>", Body(ctx));
        Assert.StartsWith("text/html", ctx.Response.ContentType);
        Assert.Equal("no-store", ctx.Response.Headers.CacheControl.ToString());
        Assert.Equal("http://127.0.0.1:8014/data/now.json?u=f", Assert.Single(_site.Asked).AbsoluteUri);
    }

    [Fact]
    public async Task OnlyWebPageWidgetsOnEnabledPagesCanBeUsed()
    {
        Assert.Equal(404, (await Get(Make(), "p/img", "/")).Response.StatusCode);   // another widget type
        Assert.Equal(404, (await Get(Make(), "p/nope", "/")).Response.StatusCode);  // no such widget
        Assert.Equal(404, (await Get(Make(enabled: false), "p/web", "/")).Response.StatusCode);
        Assert.Empty(_site.Asked);
    }

    [Fact]
    public async Task RedirectsAreFollowedOnlyOnThePagesOrigin()
    {
        _site.Reply = u => u.AbsolutePath == "/Current-Weather"
            ? new HttpResponseMessage(HttpStatusCode.Found) { Headers = { Location = new Uri("/Current-Weather/", UriKind.Relative) } }
            : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("ok") };
        var ctx = await Get(Make(), "p/web", "/Current-Weather");
        Assert.Equal(200, ctx.Response.StatusCode);
        Assert.Equal("ok", Body(ctx));

        _site.Asked.Clear();
        _site.Reply = _ => new HttpResponseMessage(HttpStatusCode.Found) { Headers = { Location = new Uri("http://192.168.1.1/admin") } };
        ctx = await Get(Make(), "p/web", "/");
        Assert.Equal(502, ctx.Response.StatusCode);
        Assert.Single(_site.Asked); // the other address was never fetched
    }

    [Fact]
    public async Task AnUnreachablePageSaysSo()
    {
        _site.Reply = _ => throw new HttpRequestException("refused");
        var ctx = await Get(Make(), "p/web", "/");
        Assert.Equal(502, ctx.Response.StatusCode);
        Assert.Contains("127.0.0.1:8014", Body(ctx));
    }

    private sealed class FakeSite : HttpMessageHandler
    {
        public readonly List<Uri> Asked = [];
        public Func<Uri, HttpResponseMessage> Reply = _ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("") };

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Assert.Equal(HttpMethod.Get, request.Method);
            Asked.Add(request.RequestUri!);
            return Task.FromResult(Reply(request.RequestUri!));
        }
    }
}
