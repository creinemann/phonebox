using PhoneBox.Agent;
using Xunit;

/// <summary>Calendar widget: the events of the days it shows, beyond the two weeks the snapshot holds.</summary>
public sealed class CalendarRangeTests
{
    private static readonly DateTime Now = new(2026, 11, 19, 12, 0, 0, DateTimeKind.Utc);

    private static long Ms(int y, int m, int d) => new DateTimeOffset(y, m, d, 0, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds();

    private static string Cal(params string[] events) =>
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n" + string.Concat(events.Select(e => "BEGIN:VEVENT\r\n" + e.Replace("\n", "\r\n") + "\r\nEND:VEVENT\r\n")) + "END:VCALENDAR\r\n";

    [Fact]
    public void AFutureMonthShowsItsEvents()
    {
        var ics = Cal("UID:1\nDTSTART:20270312T180000Z\nDTEND:20270312T190000Z\nSUMMARY:Historical society talk\nLOCATION:Juneau",
                      "UID:2\nDTSTART:20261120T150000Z\nDTEND:20261120T160000Z\nSUMMARY:Map work");
        var e = Assert.Single(CalendarMonitor.RangeOf(ics, Ms(2027, 2, 22), Ms(2027, 4, 5), Now));
        Assert.Equal("Historical society talk", e.Title);
        Assert.Equal("Juneau", e.Location);
        Assert.Equal("Test", e.Calendar);
    }

    [Fact]
    public void RecurringEventsAreExpandedInTheMonthShown()
    {
        var ics = Cal("UID:1\nDTSTART:20260105T090000Z\nDTEND:20260105T093000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO\nSUMMARY:Weekly");
        var list = CalendarMonitor.RangeOf(ics, Ms(2027, 6, 1), Ms(2027, 7, 1), Now);
        // the Mondays of June 2027, plus at most one on each extra day read either side
        Assert.InRange(list.Count, 4, 5);
        Assert.All(list, e => Assert.Equal(DayOfWeek.Monday, DateTimeOffset.FromUnixTimeMilliseconds(e.Start).UtcDateTime.DayOfWeek));
    }

    [Fact]
    public void AllDayEventsAtTheEdgesAreKeptForThePhone()
    {
        var ics = Cal("UID:1\nDTSTART;VALUE=DATE:20270301\nDTEND;VALUE=DATE:20270302\nSUMMARY:First of March");
        // the phone's first day starts 06:00 UTC (Central time); the all-day event is dated at 00:00 UTC
        Assert.Single(CalendarMonitor.RangeOf(ics, Ms(2027, 3, 1) + 6 * 3_600_000, Ms(2027, 3, 8), Now));
    }

    [Fact]
    public void TheStretchReadIsLimited()
    {
        var ics = Cal("UID:1\nDTSTART:20270601T090000Z\nDTEND:20270601T093000Z\nSUMMARY:Too far into the asked range");
        // a year asked for: only the first MaxRangeDays (and a day) are read
        Assert.Empty(CalendarMonitor.RangeOf(ics, Ms(2027, 1, 1), Ms(2028, 1, 1), Now));
        Assert.Empty(CalendarMonitor.RangeOf(ics, Ms(2027, 7, 1), Ms(2027, 6, 1), Now));
        // more than five years from today
        Assert.Empty(CalendarMonitor.RangeOf(Cal("UID:2\nDTSTART:20400601T090000Z\nDTEND:20400601T093000Z\nSUMMARY:Far"),
            Ms(2040, 5, 20), Ms(2040, 6, 20), Now));
    }

    [Fact]
    public void ABrokenFeedGivesNothingRatherThanFailing() =>
        Assert.Empty(CalendarMonitor.RangeOf("not a calendar", Ms(2027, 1, 1), Ms(2027, 2, 1), Now));
}
