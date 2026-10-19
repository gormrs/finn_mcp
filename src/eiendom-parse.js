const STREAM_CHUNK = /streamController\.enqueue\(("(?:[^"\\]|\\.)*")\)/g;

// React Router's turbo-stream encoding uses negative indexes for values that
// have no JSON equivalent. The search payload does not normally contain them,
// but decoding must not turn them into bogus properties.
const SPECIAL_VALUES = new Map([
  [-1, undefined],
  [-2, undefined],
  [-3, Number.NaN],
  [-4, Number.POSITIVE_INFINITY],
  [-5, Number.NEGATIVE_INFINITY],
  [-6, -0],
  [-7, null],
]);

function decodeReactRouterStream(html) {
  const chunks = [];
  for (const match of html.matchAll(STREAM_CHUNK)) {
    try {
      // The enqueue argument is a JS string literal containing the JSON
      // stream, so it needs to be JSON-decoded twice.
      const payload = JSON.parse(match[1]);
      const values = typeof payload === "string" ? JSON.parse(payload) : payload;
      if (Array.isArray(values)) chunks.push(...values);
    } catch {
      // Ignore scripts that are not valid turbo-stream chunks.
    }
  }
  if (chunks.length === 0) return null;

  const seen = new Map();
  const hydrate = (index, depth = 0) => {
    if (index < 0) return SPECIAL_VALUES.get(index);
    if (depth > 200) return null;
    if (seen.has(index)) return seen.get(index);

    const value = chunks[index];
    if (value === null || typeof value !== "object") return value;

    if (Array.isArray(value)) {
      const array = [];
      seen.set(index, array);
      for (const entry of value) array.push(hydrate(entry, depth + 1));
      return array;
    }

    const object = {};
    seen.set(index, object);
    for (const [key, entry] of Object.entries(value)) {
      // Turbo-stream objects are maps from encoded key indexes to value
      // indexes, for example { "_1": 2, "_3": -7 }.
      const property = key.startsWith("_") ? hydrate(Number(key.slice(1)), depth + 1) : key;
      object[String(property)] = hydrate(entry, depth + 1);
    }
    return object;
  };

  return hydrate(0);
}

export function extractEiendomSearchData(html) {
  const root = decodeReactRouterStream(html);
  const loaderData = root?.loaderData;
  if (!loaderData || typeof loaderData !== "object") return null;

  for (const [route, value] of Object.entries(loaderData)) {
    if (!route.endsWith("/search/search")) continue;
    if (Array.isArray(value?.results?.docs)) return value.results;
  }

  for (const value of Object.values(loaderData)) {
    if (Array.isArray(value?.results?.docs)) return value.results;
  }
  return null;
}

function count(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum ? value : null;
}

export function parseEiendomSearchPaging(metadata) {
  return {
    total_results: count(metadata?.result_size?.match_count),
    page: count(metadata?.paging?.current, 1),
    total_pages: count(metadata?.paging?.last),
  };
}

function formatMoney(value) {
  if (!value || typeof value.amount !== "number") return null;
  return { amount: value.amount, currency: value.currency_code ?? "NOK" };
}

function formatArea(value) {
  if (!value) return null;
  if (typeof value.size === "number") {
    if (value.size <= 0) return null;
    return { from: value.size, to: value.size, unit: value.unit ?? "m²" };
  }
  if (typeof value.size_from !== "number") return null;
  return {
    from: value.size_from,
    to: typeof value.size_to === "number" ? value.size_to : value.size_from,
    unit: value.unit ?? "m²",
  };
}

function formatPlotArea(value) {
  if (!value || typeof value.size !== "number" || value.size <= 0) return null;
  return { size: value.size, unit: value.unit ?? "m²" };
}

function formatCoordinates(value) {
  if (!value || typeof value.lat !== "number" || typeof value.lon !== "number") return null;
  return { lat: value.lat, lon: value.lon };
}

function formatPublished(value) {
  if (typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function mapEiendomDoc(doc) {
  return {
    finn_code: String(doc.ad_id ?? doc.id),
    heading: doc.heading ?? null,
    location: doc.location ?? null,
    local_area: doc.local_area_name ?? null,
    price: formatMoney(doc.price_suggestion),
    total_price: formatMoney(doc.price_total),
    monthly_shared_cost: formatMoney(doc.price_shared_cost),
    area: formatArea(doc.area_range ?? doc.area),
    plot_area: formatPlotArea(doc.area_plot),
    bedrooms: typeof doc.number_of_bedrooms === "number" ? doc.number_of_bedrooms : null,
    property_type: doc.property_type_description ?? null,
    ownership_type: doc.owner_type_description?.trim() || null,
    furnished: doc.furnished_state ?? null,
    broker: doc.organisation_name?.trim() || null,
    viewing_times: Array.isArray(doc.viewing_times) ? doc.viewing_times : [],
    features: Array.isArray(doc.features) ? doc.features : [],
    coordinates: formatCoordinates(doc.coordinates),
    published_at: formatPublished(doc.timestamp),
    url: doc.canonical_url ?? null,
    image: doc.image?.url ?? null,
    images: Array.isArray(doc.image_urls) ? doc.image_urls : [],
  };
}

export function parseEiendomSearchResults(html) {
  const results = extractEiendomSearchData(html);
  if (!results) throw new Error("Cannot parse FINN eiendom search: expected search data is missing or malformed");
  return results.docs.map(mapEiendomDoc);
}

export function parseEiendomSearchPage(html) {
  const results = extractEiendomSearchData(html);
  if (!results) throw new Error("Cannot parse FINN eiendom search: expected search data is missing or malformed");
  return {
    ...parseEiendomSearchPaging(results.metadata),
    results: results.docs.map(mapEiendomDoc),
  };
}
