const NodeHelper = require("node_helper");
const Log = require("logger");
const fs = require("fs");
const path = require("path");

module.exports = NodeHelper.create({
	start () {
		this.timers = {};
		this.latest = {};
		this.failures = {};
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "WEATHERSTRIP_START") return;
		const { id, config } = payload;
		// A page reload reconnects the frontend; resend what we have instead of waiting for the next fetch.
		if (this.latest[id]) this.sendSocketNotification("WEATHERSTRIP_DATA", this.latest[id]);
		if (this.timers[id]) return;
		// After a restart, show the last forecast we saved until a fetch succeeds,
		// rather than nothing if the forecast service happens to be down.
		const saved = this.readSaved(config);
		if (saved && !this.latest[id]) this.sendSocketNotification("WEATHERSTRIP_DATA", { ...saved, id });
		this.fetchForecast(id, config);
	},

	// Named from the coordinates as numbers only, so no config value can point it elsewhere.
	savedFile (config) {
		const [lat, lon] = [config.lat, config.lon].map(Number);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
		return path.join(this.path, ".cache", `${lat.toFixed(4)}_${lon.toFixed(4)}.json`);
	},

	readSaved (config) {
		const file = this.savedFile(config);
		if (!file) return null;
		try {
			return JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			return null;
		}
	},

	save (config, data) {
		const file = this.savedFile(config);
		if (!file) return;
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, JSON.stringify(data));
		} catch (err) {
			Log.error(`[MMM-WeatherStrip] couldn't save the forecast: ${err.message}`);
		}
	},

	// Next fetch: the normal interval after a success; after a failure, 2 minutes, doubling each
	// time it fails again, up to the normal interval.
	schedule (id, config, ok) {
		this.failures[id] = ok ? 0 : (this.failures[id] || 0) + 1;
		const wait = ok ? config.updateInterval : Math.min(config.updateInterval, 2 * 60 * 1000 * 2 ** (this.failures[id] - 1));
		this.timers[id] = setTimeout(() => this.fetchForecast(id, config), wait);
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
			if (this.failures[id]) Log.log("[MMM-WeatherStrip] forecast fetched again");
			this.latest[id] = { id, days, hours };
			this.save(config, { days, hours });
			this.sendSocketNotification("WEATHERSTRIP_DATA", this.latest[id]);
			this.schedule(id, config, true);
		} catch (err) {
			// Logged once when it starts failing, not on every retry.
			if (!this.failures[id]) Log.error(`[MMM-WeatherStrip] ${err.message}`);
			this.sendSocketNotification("WEATHERSTRIP_ERROR", { id, message: err.message });
			this.schedule(id, config, false);
		}
	}
});
