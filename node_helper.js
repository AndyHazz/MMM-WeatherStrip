const NodeHelper = require("node_helper");
const Log = require("logger");

module.exports = NodeHelper.create({
	start () {
		this.timers = {};
		this.latest = {};
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "WEATHERSTRIP_START") return;
		const { id, config } = payload;
		// A page reload reconnects the frontend; resend what we have instead of waiting for the next fetch.
		if (this.latest[id]) this.sendSocketNotification("WEATHERSTRIP_DATA", this.latest[id]);
		if (this.timers[id]) return;
		this.fetchForecast(id, config);
		this.timers[id] = setInterval(() => this.fetchForecast(id, config), config.updateInterval);
	},

	async fetchForecast (id, config) {
		const params = new URLSearchParams({
			latitude: config.lat,
			longitude: config.lon,
			daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,sunrise,sunset",
			hourly: "temperature_2m,precipitation,cloud_cover",
			timezone: config.timezone,
			past_days: "1", // yesterday's high, for today's warmer/cooler indicator
			forecast_days: String(config.days + 1) // one spare so a stale fetch still fills the strip after midnight
		});
		try {
			const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(30000) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const { daily, hourly } = await res.json();
			const days = daily.time.map((date, i) => ({
				date,
				high: daily.temperature_2m_max[i],
				low: daily.temperature_2m_min[i],
				rain: daily.precipitation_sum[i],
				sunrise: daily.sunrise[i],
				sunset: daily.sunset[i]
			}));
			const hours = hourly.time.map((time, i) => ({
				time,
				temp: hourly.temperature_2m[i],
				rain: hourly.precipitation[i],
				cloud: hourly.cloud_cover[i]
			}));
			this.latest[id] = { id, days, hours };
			this.sendSocketNotification("WEATHERSTRIP_DATA", this.latest[id]);
		} catch (err) {
			Log.error(`[MMM-WeatherStrip] ${err.message}`);
			this.sendSocketNotification("WEATHERSTRIP_ERROR", { id, message: err.message });
		}
	}
});
