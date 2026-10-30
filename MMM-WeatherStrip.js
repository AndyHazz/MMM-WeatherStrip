/* global Module, moment, config */

Module.register("MMM-WeatherStrip", {
	defaults: {
		lat: null, // required
		lon: null, // required
		timezone: "auto", // IANA name, or "auto" to use the location's own
		units: config.units, // "metric" or "imperial" for the displayed numbers
		days: 7, // 1-15
		updateInterval: 60 * 60 * 1000,
		showSky: true, // sky lane: day, twilight, night, stars, sun and clouds
		showTemperature: true, // hourly temperature line
		showComparison: true, // shading against the same hour yesterday (needs showTemperature)
		showRainBars: true, // hourly rain bars along the bottom
		showNow: true, // dotted marker at the current time
		// The settings below are always in °C and mm, whatever `units` is.
		wetThreshold: 0.5, // mm/day; drier days show their rain total dimmed
		minTempRange: 10, // °C; the temperature line is never stretched over less than this
		rainScaleMin: 1, // mm/hour at full bar height, so drizzle never fills the lane
		cloudLane: 14, // px, height of the sky lane along the top
		rainLane: 18, // px, height of the rain lane along the bottom
		cloudHours: 3, // hours per cloud puff
		starSpacing: 9, // px, average gap between stars at night
		twilightHours: 0.75 // dusk/dawn blend either side of sunset and sunrise
	},

	getStyles () {
		return ["MMM-WeatherStrip.css"];
	},

	start () {
		this.days = null;
		this.hours = [];
		this.error = null;
		if (this.config.lat === null || this.config.lon === null) {
			this.error = "Set lat and lon in the MMM-WeatherStrip config";
			return;
		}
		this.sendSocketNotification("WEATHERSTRIP_START", { id: this.identifier, config: this.config });
	},

	socketNotificationReceived (notification, payload) {
		if (payload.id !== this.identifier) return;
		if (notification === "WEATHERSTRIP_DATA") {
			this.days = payload.days;
			this.hours = payload.hours || [];
			this.error = null;
		} else if (notification === "WEATHERSTRIP_ERROR") {
			this.error = payload.message;
		}
		this.updateDom(1000);
	},

	imperial () {
		return this.config.units === "imperial";
	},

	// Data is always fetched in °C and mm; only the labels are converted.
	formatTemp (c) {
		return `${Math.round(this.imperial() ? (c * 9) / 5 + 32 : c)}°`;
	},

	formatRain (mm) {
		if (this.imperial()) {
			const inches = mm / 25.4;
			if (inches < 0.005) return "0in";
			return `${inches < 1 ? inches.toFixed(2) : inches.toFixed(1)}in`;
		}
		if (mm === 0) return "0mm";
		return `${mm < 10 ? mm.toFixed(1) : Math.round(mm)}mm`;
	},

	diffPieces (x0, d0, x1, d1) {
		if (d0 * d1 >= 0) return [{ x0, x1, f0: 0, f1: 1, diff: d0 + d1 }];
		const f = d0 / (d0 - d1);
		const xc = x0 + (x1 - x0) * f;
		return [{ x0, x1: xc, f0: 0, f1: f, diff: d0 }, { x0: xc, x1, f0: f, f1: 1, diff: d1 }];
	},

	// Small deterministic PRNG (mulberry32) seeded from a string.
	seededRandom (seed) {
		let a = [...seed].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 2654435761), 1779033703) >>> 0;
		return () => {
			a = (a + 0x6d2b79f5) >>> 0;
			let t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	},

	svgLayer (className, width) {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("class", `weatherstrip-layer ${className}`);
		svg.setAttribute("viewBox", `0 0 ${width} 100`);
		svg.setAttribute("preserveAspectRatio", "none");
		return svg;
	},

	svgEl (name, attrs) {
		const el = document.createElementNS("http://www.w3.org/2000/svg", name);
		for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
		return el;
	},

	/*
	 * Sky lane along the top. Day, twilight and night meet edge to edge, so the colour
	 * blends continuously: soft gold by day; around each sunset and sunrise a twilight
	 * band blends gold through coral into deep blue (and back at dawn); deep blue with
	 * tiny stars by night; a pale sun at solar noon. Cloud is a bank of round puffs
	 * hanging from the top edge, one per cloudHours block, sized by that block's average
	 * cover; they're solid, so they hide the sky behind them. Overcast merges into a
	 * scalloped cloud base, broken cloud leaves gaps where sun or stars show.
	 * Drawn in real pixels (W, the strip's measured width) so circles stay round.
	 */
	buildSky (dates, points, width, W) {
		const lane = this.config.cloudLane;
		const xPx = (hours) => (hours / width) * W;
		// Hours from the first shown day's midnight; works for the fetched days either side too.
		const t0 = new Date(`${dates[0]}T00:00`).getTime();
		const hoursOf = (iso) => (new Date(iso).getTime() - t0) / 3600000;
		const sky = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		sky.setAttribute("class", "weatherstrip-layer weatherstrip-clouds");
		sky.setAttribute("viewBox", `0 0 ${W} ${lane}`);
		sky.setAttribute("preserveAspectRatio", "none");

		// Sky colours come from CSS variables; one layer, so the joins match exactly.
		const id = (name) => `${this.identifier}-${name}`;
		const defs = this.svgEl("defs", {});
		const gradient = (name, stops, attrs = {}) => {
			const g = this.svgEl("linearGradient", { id: id(name), ...attrs });
			stops.forEach((style, i) => g.appendChild(this.svgEl("stop", { offset: i / (stops.length - 1), style })));
			defs.appendChild(g);
		};
		const tone = (part) => `stop-color: var(--weatherstrip-${part}); stop-opacity: var(--weatherstrip-${part}-opacity)`;
		gradient("dusk", [tone("day"), tone("twilight"), tone("night")]);
		gradient("dawn", [tone("night"), tone("twilight"), tone("day")]);
		// Fade the sky out downwards, so clear sky reads as light from above, not a bar.
		gradient("skyfade", ["stop-color: #fff; stop-opacity: 1", "stop-color: #fff; stop-opacity: 0.15"], { x1: 0, y1: 0, x2: 0, y2: 1 });
		const mask = this.svgEl("mask", { id: id("skymask") });
		mask.appendChild(this.svgEl("rect", { x: 0, y: 0, width: W, height: lane, fill: `url(#${id("skyfade")})` }));
		defs.appendChild(mask);
		sky.appendChild(defs);

		const band = this.svgEl("g", { mask: `url(#${id("skymask")})` });
		const stars = this.svgEl("g", { class: "weatherstrip-stars", mask: `url(#${id("skymask")})` });
		const suns = this.svgEl("g", { mask: `url(#${id("skymask")})` });
		const skySpan = (from, to, attrs) => {
			if (to > from) band.appendChild(this.svgEl("rect", { x: from.toFixed(1), y: 0, width: (to - from).toFixed(1), height: lane, ...attrs }));
		};
		// Every fetched day (yesterday and the spare day after the strip), so the first and
		// last nights reach the edges. Stars come from a generator seeded by the date, so
		// they stay put across refreshes.
		const tw = xPx(this.config.twilightHours);
		const sunDays = (this.days || []).filter((d) => d.sunrise && d.sunset);
		sunDays.forEach((day, i) => {
			const rise = xPx(hoursOf(day.sunrise));
			const set = xPx(hoursOf(day.sunset));
			skySpan(rise - tw, rise + tw, { fill: `url(#${id("dawn")})` });
			skySpan(rise + tw, set - tw, { class: "weatherstrip-sky-day" });
			skySpan(set - tw, set + tw, { fill: `url(#${id("dusk")})` });
			suns.appendChild(this.svgEl("circle", { class: "weatherstrip-sun-disc", cx: ((rise + set) / 2).toFixed(1), cy: (lane * 0.42).toFixed(1), r: (lane * 0.45).toFixed(1) }));
			const next = sunDays[i + 1];
			if (!next) return;
			const dark = set + tw;
			const light = xPx(hoursOf(next.sunrise)) - tw;
			skySpan(dark, light, { class: "weatherstrip-sky-night" });
			const rand = this.seededRandom(day.date);
			const count = Math.floor((light - dark) / this.config.starSpacing);
			for (let k = 0; k < count; k++) {
				stars.appendChild(this.svgEl("circle", {
					cx: (dark + ((k + rand()) / count) * (light - dark)).toFixed(1),
					cy: (1 + rand() * lane * 0.75).toFixed(1),
					r: (0.45 + rand() * 0.55).toFixed(2),
					"fill-opacity": (0.45 + rand() * 0.5).toFixed(2)
				}));
			}
		});
		sky.appendChild(band);
		sky.appendChild(stars);
		sky.appendChild(suns);

		const clouds = points.filter((h) => h.cloud !== null && h.cloud !== undefined);
		const step = this.config.cloudHours;
		const puffs = this.svgEl("g", { class: "weatherstrip-cloud" });
		for (let start = 0; start < width; start += step) {
			const block = clouds.filter((h) => h.x >= start && h.x < start + step);
			if (!block.length) continue;
			const cover = block.reduce((sum, h) => sum + h.cloud, 0) / block.length;
			const r = (cover / 100) * lane * 1.15;
			if (r < 1.5) continue;
			puffs.appendChild(this.svgEl("circle", { cx: xPx(start + step / 2).toFixed(1), cy: (-lane * 0.25).toFixed(1), r: r.toFixed(1) }));
		}
		sky.appendChild(puffs);
		return sky;
	},

	// Temperature: one line across the week, with the gap to the same hour yesterday
	// filled blue where it's colder (yesterday above the line) or red where it's warmer.
	buildTemperature (points, width) {
		const temp = this.svgLayer("weatherstrip-temp", width);
		const temps = points.flatMap((h) => (h.prev === null || !this.config.showComparison ? [h.temp] : [h.temp, h.prev]));
		const tMin = Math.min(...temps);
		const tMax = Math.max(...temps);
		// Scaled to the week, but never stretched over less than minTempRange degrees, so a flat
		// week stays flat; a narrower week sits centred in the band.
		const span = Math.max(tMax - tMin, this.config.minTempRange);
		const lo = (tMin + tMax) / 2 - span / 2;
		const y = (t) => 92 - ((t - lo) / span) * 84;
		if (this.config.showComparison) {
			// Consecutive hours with the same sign become one shape: along today's line, back
			// along yesterday's. One polygon per run avoids anti-aliasing seams between slices.
			let run = null;
			const flush = () => {
				if (run) {
					const edge = [...run.today, ...run.prev.reverse()].map(([px, t]) => `${px},${y(t).toFixed(2)}`).join(" ");
					temp.appendChild(this.svgEl("polygon", { class: run.colder ? "weatherstrip-colder" : "weatherstrip-warmer", points: edge }));
				}
				run = null;
			};
			for (let i = 1; i < points.length; i++) {
				const a = points[i - 1];
				const b = points[i];
				if (a.prev === null || b.prev === null || b.x - a.x !== 1) {
					flush();
					continue;
				}
				for (const piece of this.diffPieces(a.x + 0.5, a.temp - a.prev, b.x + 0.5, b.temp - b.prev)) {
					const colder = piece.diff < 0;
					const at = (f) => [a.temp + (b.temp - a.temp) * f, a.prev + (b.prev - a.prev) * f];
					const [pa, qa] = at(piece.f0);
					const [pb, qb] = at(piece.f1);
					if (!run || run.colder !== colder) {
						flush();
						run = { colder, today: [[piece.x0, pa]], prev: [[piece.x0, qa]] };
					}
					run.today.push([piece.x1, pb]);
					run.prev.push([piece.x1, qb]);
				}
			}
			flush();
		}
		temp.appendChild(this.svgEl("polyline", {
			class: "weatherstrip-templine",
			points: points.map((h) => `${h.x + 0.5},${y(h.temp).toFixed(2)}`).join(" ")
		}));
		return temp;
	},

	// Rain: hourly bars rising from the bottom of the rain lane.
	buildRain (points, width) {
		const rain = this.svgLayer("weatherstrip-rainlane", width);
		const rainMax = Math.max(this.config.rainScaleMin, ...points.map((h) => h.rain || 0));
		for (const h of points) {
			if (!h.rain) continue;
			const height = Math.max(8, (Math.min(h.rain, rainMax) / rainMax) * 100);
			rain.appendChild(this.svgEl("rect", { class: "weatherstrip-rainbar", x: h.x + 0.15, width: 0.7, y: 100 - height, height }));
		}
		return rain;
	},

	/*
	 * Faint hourly charts behind the day cells. x is in hours from today 00:00, so each
	 * day cell spans exactly 24 units. Sky, temperature and rain each get their own
	 * layer and scale rather than sharing one plot.
	 */
	buildChart (days, W) {
		const dates = days.map((d) => d.date);
		const points = this.hours
			.map((h, i) => ({
				...h,
				x: dates.indexOf(h.time.slice(0, 10)) * 24 + Number(h.time.slice(11, 13)),
				prev: i >= 24 ? this.hours[i - 24].temp : null
			}))
			.filter((h) => h.x >= 0 && h.temp !== null);
		if (points.length < 2) return [];

		const width = days.length * 24;
		const layers = [];
		if (this.config.showSky) layers.push(this.buildSky(dates, points, width, W));
		if (this.config.showTemperature) layers.push(this.buildTemperature(points, width));
		if (this.config.showRainBars) layers.push(this.buildRain(points, width));

		// Now: dotted line through all lanes in today's column.
		const now = moment();
		if (this.config.showNow && now.format("YYYY-MM-DD") === dates[0]) {
			const x = now.hours() + now.minutes() / 60;
			const marker = this.svgLayer("weatherstrip-nowlayer", width);
			marker.appendChild(this.svgEl("line", { class: "weatherstrip-now", x1: x, x2: x, y1: 0, y2: 100 }));
			layers.push(marker);
		}
		return layers;
	},

	getDom () {
		const wrapper = document.createElement("div");

		// Drop days that have passed since the last successful fetch.
		const today = moment().format("YYYY-MM-DD");
		const days = (this.days || []).filter((d) => d.date >= today).slice(0, this.config.days);

		if (days.length === 0) {
			wrapper.className = "dimmed light small";
			wrapper.textContent = this.error ? `Forecast unavailable: ${this.error}` : this.translate("LOADING");
			return wrapper;
		}

		wrapper.className = "weatherstrip";
		wrapper.style.setProperty("--cloud-lane", `${this.config.showSky ? this.config.cloudLane : 0}px`);
		wrapper.style.setProperty("--rain-lane", `${this.config.showRainBars ? this.config.rainLane : 0}px`);
		wrapper.style.gridTemplateColumns = `repeat(${days.length}, 1fr)`;
		if (this.error) wrapper.classList.add("stale");

		// The sky is drawn in real pixels, so it needs the strip's width: first guess the
		// window width, then redraw once if the strip turns out to be narrower or wider.
		const W = this.measuredWidth || window.innerWidth;
		this.resizeObserver?.disconnect();
		this.resizeObserver = new ResizeObserver(([entry]) => {
			const w = Math.round(entry.contentRect.width);
			if (w > 0 && Math.abs(w - W) > 2) {
				this.measuredWidth = w;
				this.updateDom(0);
			}
		});
		this.resizeObserver.observe(wrapper);

		for (const layer of this.buildChart(days, W)) wrapper.appendChild(layer);

		for (const day of days) {
			const cell = document.createElement("div");
			cell.className = "weatherstrip-day";

			const name = day.date === today ? this.translate("TODAY") : moment(day.date).format("ddd");
			const wet = day.rain >= this.config.wetThreshold;
			cell.innerHTML = `
				<div class="weatherstrip-name xsmall dimmed">${name}</div>
				<div class="weatherstrip-temps small">
					<span class="bright">${this.formatTemp(day.high)}</span>
					<span class="dimmed">${this.formatTemp(day.low)}</span>
				</div>
				<div class="weatherstrip-rain xsmall ${wet ? "wet" : "dimmed"}">
					<i class="fa-solid fa-droplet"></i> ${this.formatRain(day.rain)}
				</div>`;
			wrapper.appendChild(cell);
		}
		return wrapper;
	}
});
