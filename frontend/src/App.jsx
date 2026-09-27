import React, { useState, useEffect, useRef, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

function formatCurrency(amount) {
  if (amount === null || amount === undefined) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount);
}

function formatDate(isoString) {
  if (!isoString) return '—';
  try {
    const date = new Date(isoString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZone: 'UTC',
    }) + ' UTC';
  } catch {
    return isoString;
  }
}

export default function App() {
  // Tracked products state
  const [trackedProducts, setTrackedProducts] = useState([]);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [productHistory, setProductHistory] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Per-product scrape state: tracks which product is currently being scraped
  const [scrapingProductId, setScrapingProductId] = useState(null);
  // Polling: after a per-product scrape starts, poll for new history rows
  const pollTimerRef = useRef(null);

  // Search & Catalog state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedCatalogItem, setSelectedCatalogItem] = useState(null);
  const [catalogDetails, setCatalogDetails] = useState(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [selectedOption, setSelectedOption] = useState(null);
  const [trackingProduct, setTrackingProduct] = useState(false);

  const [alert, setAlert] = useState(null);
  const searchTimeoutRef = useRef(null);

  // Notification helper (auto-clears after 6s)
  const showAlert = (message, type = 'info') => {
    setAlert({ message, type });
    setTimeout(() => setAlert(null), 6000);
  };

  // ── 1. Fetch tracked products ────────────────────────────────────────
  const fetchTrackedProducts = useCallback(async ({ selectId } = {}) => {
    try {
      setLoadingProducts(true);
      const res = await fetch(`${API_BASE}/api/products`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTrackedProducts(data);

      if (selectId) {
        const target = data.find((p) => p.id === selectId);
        if (target) setSelectedProduct(target);
      } else {
        setSelectedProduct((prev) => {
          if (prev) return prev; // keep current selection
          return data.length > 0 ? data[0] : null;
        });
      }
    } catch (err) {
      showAlert(`Failed to fetch tracked products: ${err.message}`, 'danger');
    } finally {
      setLoadingProducts(false);
    }
  }, []);

  useEffect(() => {
    fetchTrackedProducts();
  }, [fetchTrackedProducts]);

  // ── 2. Fetch history whenever selected product changes ───────────────
  const fetchHistory = useCallback(async (productId) => {
    if (!productId) { setProductHistory([]); return; }
    try {
      setLoadingHistory(true);
      const res = await fetch(`${API_BASE}/api/products/${productId}/history`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setProductHistory(await res.json());
    } catch (err) {
      showAlert(`Failed to fetch history: ${err.message}`, 'danger');
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory(selectedProduct?.id);
  }, [selectedProduct, fetchHistory]);

  // ── 3. Search debouncer ──────────────────────────────────────────────
  useEffect(() => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (!searchQuery.trim()) { setSearchResults([]); setSearching(false); return; }
    setSearching(true);
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/search?query=${encodeURIComponent(searchQuery.trim())}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setSearchResults(await res.json());
      } catch (err) {
        showAlert(`Search failed: ${err.message}`, 'danger');
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(searchTimeoutRef.current);
  }, [searchQuery]);

  // ── 4. Select a catalog search result to load its options ────────────
  const handleSelectSearchItem = async (item) => {
    setSelectedCatalogItem(item);
    setSelectedOption(null);
    setLoadingCatalog(true);
    try {
      const res = await fetch(`${API_BASE}/api/catalog/${encodeURIComponent(item.id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const details = await res.json();
      setCatalogDetails(details);
      if (details.options?.length > 0) setSelectedOption(details.options[0]);
    } catch (err) {
      showAlert(`Failed to load options: ${err.message}`, 'danger');
    } finally {
      setLoadingCatalog(false);
    }
  };

  // ── 5. Trigger a single-product scrape (no secret needed) ────────────
  //    Called: (a) right after tracking a new product,
  //            (b) when user clicks "Check Price Now" on any product card.
  const triggerSingleScrape = useCallback(async (productId, productName) => {
    if (scrapingProductId) return; // prevent double-trigger
    setScrapingProductId(productId);
    showAlert(`Checking current price for "${productName}"... This takes ~20–40s. The page will auto-refresh.`, 'info');

    try {
      const res = await fetch(`${API_BASE}/api/products/${productId}/scrape`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      // Poll every 10s for up to 90s to detect when new history row appears
      let polls = 0;
      const maxPolls = 9;
      const previousCount = productHistory.length;

      clearInterval(pollTimerRef.current);
      pollTimerRef.current = setInterval(async () => {
        polls++;
        try {
          const hRes = await fetch(`${API_BASE}/api/products/${productId}/history`);
          if (hRes.ok) {
            const newHistory = await hRes.json();
            if (newHistory.length > previousCount || polls >= maxPolls) {
              clearInterval(pollTimerRef.current);
              setScrapingProductId(null);
              if (selectedProduct?.id === productId) {
                setProductHistory(newHistory);
              }
              if (newHistory.length > previousCount) {
                const latest = newHistory[0];
                if (latest.outcome === 'success') {
                  showAlert(`✅ Price updated! ${productName}: ${formatCurrency(latest.price)}, Stock: ${latest.stock}`, 'info');
                } else {
                  showAlert(`⚠️ Scrape completed (outcome: ${latest.outcome}). Will retry on next scheduled run.`, 'info');
                }
              }
            }
          }
        } catch { /* swallow polling errors */ }
        if (polls >= maxPolls) {
          clearInterval(pollTimerRef.current);
          setScrapingProductId(null);
        }
      }, 10000);
    } catch (err) {
      showAlert(`Failed to start scrape: ${err.message}`, 'danger');
      setScrapingProductId(null);
    }
  }, [scrapingProductId, productHistory.length, selectedProduct]);

  // ── 6. Track a product then immediately scrape it ────────────────────
  const handleTrackProduct = async () => {
    if (!selectedCatalogItem || !selectedOption) return;
    setTrackingProduct(true);
    try {
      const res = await fetch(`${API_BASE}/api/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeProductId: String(selectedCatalogItem.id),
          productName: selectedCatalogItem.name,
          optionId: selectedOption.id,
          optionLabel: selectedOption.label,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${res.status}`);
      }

      const newProduct = await res.json();

      // Reset search UI
      setSearchQuery('');
      setSearchResults([]);
      setSelectedCatalogItem(null);
      setCatalogDetails(null);
      setSelectedOption(null);

      // Refresh list and select the new product
      await fetchTrackedProducts({ selectId: newProduct.id });

      // FIX 1: Auto-scrape immediately so price shows right away
      triggerSingleScrape(newProduct.id, newProduct.product_name);
    } catch (err) {
      showAlert(`Could not track product: ${err.message}`, 'danger');
    } finally {
      setTrackingProduct(false);
    }
  };

  // ── Derived data ─────────────────────────────────────────────────────
  const latestScrape = productHistory.length > 0 ? productHistory[0] : null;
  const latestSuccess = productHistory.find((h) => h.outcome === 'success');

  // FIX 3: Chart must only use rows with a real price (successful rows), oldest → newest
  const chartPoints = [...productHistory]
    .filter((h) => h.outcome === 'success' && h.price !== null && h.price !== undefined)
    .reverse(); // DB returns newest first, chart needs oldest first

  // ─────────────────────────────────────────────────────────────────────
  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="brand-section">
          <div className="brand-icon">⚡</div>
          <div>
            <h1 className="brand-title">INE Price &amp; Stock Tracker</h1>
            <p className="brand-subtitle">Automated unattended scraping monitor for INE Mock Store</p>
          </div>
        </div>

        <div className="header-actions">
          {/* FIX 2: Removed secret-prompt "Trigger Scrape Now" button.
              Per-product "Check Price Now" buttons are on each product card instead. */}
          <a
            className="btn btn-primary"
            href={`${API_BASE}/api/export.csv`}
            download="scrape_history.csv"
            target="_blank"
            rel="noreferrer"
          >
            <span>⬇</span>
            <span>Export CSV</span>
          </a>
        </div>
      </header>

      {/* Alert Banner */}
      {alert && (
        <div className={`banner banner-${alert.type}`}>
          <span>{alert.message}</span>
          <button style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }} onClick={() => setAlert(null)}>✕</button>
        </div>
      )}

      {/* Main Grid */}
      <div className="dashboard-grid">
        {/* Left Column: Search & Tracked List */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* Card: Search & Track */}
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">🔍 Find &amp; Track Product</h2>
            </div>

            <div className="search-wrapper">
              <span className="search-icon">🔍</span>
              <input
                type="text"
                className="search-input"
                placeholder="Search mock store (e.g. tablet, phone, watch)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            {searching && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                <span className="spinner"></span>
                <span>Searching mock store catalog...</span>
              </div>
            )}

            {searchResults.length > 0 && (
              <div className="search-results">
                {searchResults.map((item) => (
                  <div
                    key={item.id}
                    className={`search-item ${selectedCatalogItem?.id === item.id ? 'selected' : ''}`}
                    onClick={() => handleSelectSearchItem(item)}
                  >
                    <div className="search-item-info">
                      <span className="search-item-name">{item.name}</span>
                      <span className="search-item-id">ID: {item.id}</span>
                    </div>
                    <span style={{ fontSize: '0.8rem', color: 'var(--accent)' }}>Select →</span>
                  </div>
                ))}
              </div>
            )}

            {selectedCatalogItem && (
              <div className="options-panel">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="options-label">Select Option to Track:</span>
                  {loadingCatalog && <span className="spinner"></span>}
                </div>

                {catalogDetails?.options?.length > 0 ? (
                  <div className="options-grid">
                    {catalogDetails.options.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`option-chip ${selectedOption?.id === opt.id ? 'selected' : ''}`}
                        onClick={() => setSelectedOption(opt)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  !loadingCatalog && <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>No options found.</span>
                )}

                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ width: '100%', justifyContent: 'center', marginTop: '6px' }}
                  onClick={handleTrackProduct}
                  disabled={!selectedOption || trackingProduct}
                >
                  {trackingProduct ? <span className="spinner"></span> : '+'}
                  <span>{trackingProduct ? 'Adding & Checking Price...' : `Track "${selectedOption?.label || ''}"`}</span>
                </button>
              </div>
            )}
          </div>

          {/* Card: Tracked Products List */}
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">
                📦 Tracked Products
                <span className="badge badge-neutral">{trackedProducts.length}</span>
              </h2>
              <button
                className="btn btn-outline"
                style={{ padding: '4px 8px', fontSize: '0.75rem' }}
                onClick={() => fetchTrackedProducts()}
              >
                🔄 Refresh
              </button>
            </div>

            {loadingProducts ? (
              <div className="empty-state">
                <span className="spinner"></span>
                <span>Loading tracked products...</span>
              </div>
            ) : trackedProducts.length === 0 ? (
              <div className="empty-state">
                <span>No products tracked yet.</span>
                <span style={{ fontSize: '0.78rem' }}>Use the search box above to track at least 2–3 products.</span>
              </div>
            ) : (
              <div className="product-list">
                {trackedProducts.map((p) => {
                  const isActive = selectedProduct?.id === p.id;
                  const isScraping = scrapingProductId === p.id;
                  return (
                    <div
                      key={p.id}
                      className={`product-item ${isActive ? 'active' : ''}`}
                      onClick={() => setSelectedProduct(p)}
                    >
                      <div className="product-item-header">
                        <span className="product-name">{p.product_name}</span>
                        <span className="badge badge-neutral">{p.option_label}</span>
                      </div>
                      <div className="product-meta">
                        <span>Store ID: #{p.store_product_id}</span>
                        <span>•</span>
                        <span>Tracked on {new Date(p.created_at).toLocaleDateString()}</span>
                      </div>
                      {/* FIX 2: Per-product Check Price Now button — no secret needed */}
                      <button
                        type="button"
                        className="btn btn-outline"
                        style={{ width: '100%', justifyContent: 'center', marginTop: '6px', fontSize: '0.78rem', padding: '5px 10px' }}
                        disabled={isScraping || scrapingProductId !== null}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedProduct(p);
                          triggerSingleScrape(p.id, p.product_name);
                        }}
                      >
                        {isScraping ? (
                          <><span className="spinner"></span><span>Checking price...</span></>
                        ) : (
                          <><span>🔄</span><span>Check Price Now</span></>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Selected Product Detail */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {selectedProduct ? (
            <>
              {/* Product Overview Card */}
              <div className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title">{selectedProduct.product_name}</h2>
                    <p style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                      Option: <strong style={{ color: 'var(--text-primary)' }}>{selectedProduct.option_label}</strong> (Store ID #{selectedProduct.store_product_id})
                    </p>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    {latestScrape && (
                      <span className={`badge badge-${latestScrape.outcome === 'success' ? 'success' : latestScrape.outcome === 'retried' ? 'warning' : 'danger'}`}>
                        Latest: {latestScrape.outcome}
                      </span>
                    )}
                    {scrapingProductId === selectedProduct.id && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        <span className="spinner"></span> Scraping...
                      </span>
                    )}
                  </div>
                </div>

                {/* Stat Highlights */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px', marginTop: '6px' }}>
                  <div style={{ background: 'var(--bg-card)', padding: '12px 16px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Current Price</div>
                    <div className="price-display">
                      {scrapingProductId === selectedProduct.id
                        ? <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Checking...</span>
                        : latestSuccess
                          ? formatCurrency(latestSuccess.price)
                          : <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>No data yet</span>
                      }
                    </div>
                  </div>

                  <div style={{ background: 'var(--bg-card)', padding: '12px 16px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Current Stock</div>
                    <div style={{ fontSize: '1.15rem', fontWeight: '700', marginTop: '2px' }}>
                      {scrapingProductId === selectedProduct.id
                        ? <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Checking...</span>
                        : latestSuccess
                          ? (latestSuccess.stock === 0
                              ? <span style={{ color: 'var(--danger)' }}>Sold Out</span>
                              : <span style={{ color: 'var(--success)' }}>{latestSuccess.stock} units available</span>)
                          : '—'
                      }
                    </div>
                  </div>

                  <div style={{ background: 'var(--bg-card)', padding: '12px 16px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Total Scrape Attempts</div>
                    <div style={{ fontSize: '1.15rem', fontWeight: '700', marginTop: '2px' }}>
                      {productHistory.length} attempts
                    </div>
                  </div>
                </div>
              </div>

              {/* Price Trend Chart */}
              <div className="card">
                <div className="card-header">
                  <h3 className="card-title">📈 Price History Trend</h3>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                    {chartPoints.length} successful data point{chartPoints.length !== 1 ? 's' : ''}
                  </span>
                </div>

                {chartPoints.length < 2 ? (
                  <div className="empty-state" style={{ height: '180px' }}>
                    <span>
                      {chartPoints.length === 1
                        ? '1 data point — need at least 2 to draw a trend line. More points will appear after scheduled runs.'
                        : 'No price data yet. Click "Check Price Now" or wait for the 2-hour scheduled run.'}
                    </span>
                  </div>
                ) : (
                  <div className="chart-container">
                    <SimpleLineChart data={chartPoints} />
                  </div>
                )}
              </div>

              {/* Scrape Audit Log */}
              <div className="card">
                <div className="card-header">
                  <div>
                    <h3 className="card-title">📜 Audit Scrape Log</h3>
                    <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                      Every attempt recorded honestly — retries, upstream errors, and successes
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    {loadingHistory && <span className="spinner"></span>}
                    <button
                      className="btn btn-outline"
                      style={{ padding: '4px 8px', fontSize: '0.75rem' }}
                      onClick={() => fetchHistory(selectedProduct?.id)}
                    >
                      🔄
                    </button>
                  </div>
                </div>

                {productHistory.length === 0 ? (
                  <div className="empty-state">
                    {scrapingProductId === selectedProduct.id
                      ? <><span className="spinner"></span><span>Scrape in progress, logs will appear shortly...</span></>
                      : <span>No scrape logs yet. Click "Check Price Now" above to trigger the first scrape.</span>
                    }
                  </div>
                ) : (
                  <div className="table-wrapper">
                    <table className="history-table">
                      <thead>
                        <tr>
                          <th>Timestamp (UTC)</th>
                          <th>Outcome</th>
                          <th>Price</th>
                          <th>Stock</th>
                          <th>Detail / Error Message</th>
                        </tr>
                      </thead>
                      <tbody>
                        {productHistory.map((row) => (
                          <tr key={row.id}>
                            <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{formatDate(row.timestamp)}</td>
                            <td>
                              <span className={`badge badge-${row.outcome === 'success' ? 'success' : row.outcome === 'retried' ? 'warning' : 'danger'}`}>
                                {row.outcome}
                              </span>
                            </td>
                            <td style={{ fontWeight: row.price ? 600 : 400 }}>
                              {row.price !== null ? formatCurrency(row.price) : '—'}
                            </td>
                            <td>
                              {row.stock !== null
                                ? row.stock === 0
                                  ? <span className="badge badge-danger">Sold Out (0)</span>
                                  : <span className="pill-stock">{row.stock} in stock</span>
                                : '—'}
                            </td>
                            <td>
                              <span className="detail-text" title={row.detail || ''}>
                                {row.detail || (row.outcome === 'success' ? 'Price and stock verified ✓' : '—')}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="card empty-state" style={{ minHeight: '360px', justifyContent: 'center' }}>
              <span style={{ fontSize: '28px' }}>👈</span>
              <span style={{ fontWeight: 600 }}>Select a product from the list to view its price history and scrape logs.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Dependency-free SVG Line Chart ────────────────────────────────────
// FIX 3: Only receives pre-filtered success rows (price is always a real number)
function SimpleLineChart({ data }) {
  if (!data || data.length < 2) return null;

  const width = 760;
  const height = 180;
  const padding = { top: 20, right: 30, bottom: 40, left: 70 };

  const prices = data.map((d) => d.price);
  const rawMin = Math.min(...prices);
  const rawMax = Math.max(...prices);

  // If all prices are identical, add a 5% buffer so the line is centered
  const spread = rawMax - rawMin;
  const minPrice = spread === 0 ? rawMin * 0.95 : rawMin * 0.97;
  const maxPrice = spread === 0 ? rawMax * 1.05 : rawMax * 1.03;
  const priceRange = maxPrice - minPrice;

  const getX = (index) =>
    padding.left + (index / (data.length - 1)) * (width - padding.left - padding.right);

  const getY = (price) =>
    height - padding.bottom - ((price - minPrice) / priceRange) * (height - padding.top - padding.bottom);

  const points = data.map((d, i) => `${getX(i)},${getY(d.price)}`).join(' ');

  const formatCurrencyShort = (n) => {
    if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
    if (n >= 1000) return `₹${(n / 1000).toFixed(1)}K`;
    return `₹${Math.round(n)}`;
  };

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg">
      <defs>
        <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.0" />
        </linearGradient>
      </defs>

      {/* Grid lines */}
      {[0, 0.5, 1].map((frac) => {
        const y = padding.top + frac * (height - padding.top - padding.bottom);
        const price = maxPrice - frac * priceRange;
        return (
          <g key={frac}>
            <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke="#334155" strokeDasharray="3 3" strokeWidth="0.8" />
            <text x={padding.left - 6} y={y + 4} fill="#94a3b8" fontSize="10" textAnchor="end">
              {formatCurrencyShort(price)}
            </text>
          </g>
        );
      })}

      {/* X-axis labels: first, middle, last */}
      {[0, Math.floor((data.length - 1) / 2), data.length - 1]
        .filter((v, i, a) => a.indexOf(v) === i)
        .map((i) => (
          <text key={i} x={getX(i)} y={height - 4} fill="#94a3b8" fontSize="9" textAnchor="middle">
            {new Date(data[i].timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })}
          </text>
        ))}

      {/* Fill area */}
      <polygon
        points={`${getX(0)},${height - padding.bottom} ${points} ${getX(data.length - 1)},${height - padding.bottom}`}
        fill="url(#chartGradient)"
      />

      {/* Trend line */}
      <polyline fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeLinejoin="round" points={points} />

      {/* Data points with price tooltip on hover */}
      {data.map((d, i) => (
        <g key={i}>
          <circle cx={getX(i)} cy={getY(d.price)} r="5" fill="#0f172a" stroke="#3b82f6" strokeWidth="2" />
          <title>{`₹${d.price.toLocaleString('en-IN')} — ${new Date(d.timestamp).toLocaleString()}`}</title>
        </g>
      ))}
    </svg>
  );
}
