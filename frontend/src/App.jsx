import React, { useState, useEffect, useRef } from 'react';

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

  // Search & Catalog state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedCatalogItem, setSelectedCatalogItem] = useState(null);
  const [catalogDetails, setCatalogDetails] = useState(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [selectedOption, setSelectedOption] = useState(null);
  const [trackingProduct, setTrackingProduct] = useState(false);

  // Action states
  const [scrapingAll, setScrapingAll] = useState(false);
  const [alert, setAlert] = useState(null);
  const searchTimeoutRef = useRef(null);

  // Notification helper
  const showAlert = (message, type = 'info') => {
    setAlert({ message, type });
    setTimeout(() => setAlert(null), 5000);
  };

  // 1. Fetch tracked products on mount
  const fetchTrackedProducts = async () => {
    try {
      setLoadingProducts(true);
      const res = await fetch(`${API_BASE}/api/products`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTrackedProducts(data);
      if (data.length > 0 && !selectedProduct) {
        setSelectedProduct(data[0]);
      }
    } catch (err) {
      showAlert(`Failed to fetch tracked products: ${err.message}`, 'danger');
    } finally {
      setLoadingProducts(false);
    }
  };

  useEffect(() => {
    fetchTrackedProducts();
  }, []);

  // 2. Fetch history whenever selected product changes
  useEffect(() => {
    if (!selectedProduct) {
      setProductHistory([]);
      return;
    }

    const fetchHistory = async () => {
      try {
        setLoadingHistory(true);
        const res = await fetch(`${API_BASE}/api/products/${selectedProduct.id}/history`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setProductHistory(data);
      } catch (err) {
        showAlert(`Failed to fetch history for ${selectedProduct.product_name}: ${err.message}`, 'danger');
      } finally {
        setLoadingHistory(false);
      }
    };

    fetchHistory();
  }, [selectedProduct]);

  // 3. Search debouncer
  useEffect(() => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);

    if (!searchQuery.trim()) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/search?query=${encodeURIComponent(searchQuery.trim())}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setSearchResults(data);
      } catch (err) {
        showAlert(`Search failed: ${err.message}`, 'danger');
      } finally {
        setSearching(false);
      }
    }, 350);

    return () => clearTimeout(searchTimeoutRef.current);
  }, [searchQuery]);

  // 4. Select an item from search results to load options
  const handleSelectSearchItem = async (item) => {
    setSelectedCatalogItem(item);
    setSelectedOption(null);
    setLoadingCatalog(true);
    try {
      const res = await fetch(`${API_BASE}/api/catalog/${encodeURIComponent(item.id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const details = await res.json();
      setCatalogDetails(details);
      if (details.options && details.options.length > 0) {
        setSelectedOption(details.options[0]);
      }
    } catch (err) {
      showAlert(`Failed to load options: ${err.message}`, 'danger');
    } finally {
      setLoadingCatalog(false);
    }
  };

  // 5. Track chosen product + option
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
      showAlert(`Successfully tracking "${newProduct.product_name}" (${newProduct.option_label})!`, 'info');
      
      // Reset search drawer and refresh
      setSearchQuery('');
      setSearchResults([]);
      setSelectedCatalogItem(null);
      setCatalogDetails(null);
      setSelectedOption(null);

      // Refresh products list and select the new product
      await fetchTrackedProducts();
      setSelectedProduct(newProduct);
    } catch (err) {
      showAlert(`Could not track product: ${err.message}`, 'danger');
    } finally {
      setTrackingProduct(false);
    }
  };

  // 6. Manual Scrape All trigger (useful for testing & evaluation)
  const handleManualScrape = async () => {
    const secret = window.prompt("Enter your SCRAPE_SECRET to trigger an immediate scrape run:");
    if (!secret) return;

    setScrapingAll(true);
    showAlert("Triggering scrape across all tracked products... This may take ~30-60s.", "info");

    try {
      const res = await fetch(`${API_BASE}/api/scrape-all`, {
        method: 'POST',
        headers: {
          'x-scrape-secret': secret,
        },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const result = await res.json();
      showAlert(`Scrape completed! Scraped ${result.scraped} products.`, "info");
      
      // Refresh current product's history
      if (selectedProduct) {
        const historyRes = await fetch(`${API_BASE}/api/products/${selectedProduct.id}/history`);
        if (historyRes.ok) {
          setProductHistory(await historyRes.json());
        }
      }
    } catch (err) {
      showAlert(`Scrape run failed: ${err.message}`, "danger");
    } finally {
      setScrapingAll(false);
    }
  };

  // Derive latest valid scrape from history
  const latestScrape = productHistory.length > 0 ? productHistory[0] : null;
  const latestSuccess = productHistory.find((h) => h.outcome === 'success');

  // Chart data: successful points ordered from oldest to newest
  const chartPoints = [...productHistory]
    .filter((h) => h.price !== null)
    .reverse();

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="brand-section">
          <div className="brand-icon">⚡</div>
          <div>
            <h1 className="brand-title">INE Price & Stock Tracker</h1>
            <p className="brand-subtitle">Automated unattended scraping monitor for INE Mock Store</p>
          </div>
        </div>

        <div className="header-actions">
          <button 
            className="btn btn-outline" 
            onClick={handleManualScrape}
            disabled={scrapingAll || trackedProducts.length === 0}
          >
            {scrapingAll ? <span className="spinner"></span> : '▶'}
            <span>{scrapingAll ? 'Scraping...' : 'Trigger Scrape Now'}</span>
          </button>

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
              <h2 className="card-title">🔍 Find & Track Product</h2>
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

            {/* Live Search Results */}
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

            {/* Option Picker for Selected Search Item */}
            {selectedCatalogItem && (
              <div className="options-panel">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="options-label">Select Option to Track:</span>
                  {loadingCatalog && <span className="spinner"></span>}
                </div>

                {catalogDetails?.options && catalogDetails.options.length > 0 ? (
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
                  <span>{trackingProduct ? 'Adding to Tracker...' : `Track "${selectedOption?.label || ''}"`}</span>
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
                onClick={fetchTrackedProducts}
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
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Selected Product History & Scrape Logs */}
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

                  {latestScrape && (
                    <span className={`badge badge-${latestScrape.outcome === 'success' ? 'success' : latestScrape.outcome === 'retried' ? 'warning' : 'danger'}`}>
                      Latest: {latestScrape.outcome}
                    </span>
                  )}
                </div>

                {/* Stat Highlights */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px', marginTop: '6px' }}>
                  <div style={{ background: 'var(--bg-card)', padding: '12px 16px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Current Price</div>
                    <div className="price-display">
                      {latestSuccess ? formatCurrency(latestSuccess.price) : 'Pending first run'}
                    </div>
                  </div>

                  <div style={{ background: 'var(--bg-card)', padding: '12px 16px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Current Stock</div>
                    <div style={{ fontSize: '1.15rem', fontWeight: '700', marginTop: '2px' }}>
                      {latestSuccess ? (
                        latestSuccess.stock === 0 ? (
                          <span style={{ color: 'var(--danger)' }}>Sold Out (0)</span>
                        ) : (
                          <span style={{ color: 'var(--success)' }}>{latestSuccess.stock} units available</span>
                        )
                      ) : (
                        '—'
                      )}
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

              {/* Price Trend Chart Card */}
              <div className="card">
                <div className="card-header">
                  <h3 className="card-title">📈 Price History Trend</h3>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Over unattended scrape runs</span>
                </div>

                {chartPoints.length < 2 ? (
                  <div className="empty-state" style={{ height: '180px' }}>
                    <span>Not enough price points to draw chart yet.</span>
                    <span style={{ fontSize: '0.78rem' }}>Run a scrape or wait for scheduled runs to populate points.</span>
                  </div>
                ) : (
                  <div className="chart-container">
                    <SimpleLineChart data={chartPoints} />
                  </div>
                )}
              </div>

              {/* Per-Product Scrape Log Card (PDF Requirement: Failures must be recorded honestly) */}
              <div className="card">
                <div className="card-header">
                  <div>
                    <h3 className="card-title">📜 Audit Scrape Log</h3>
                    <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                      Every scrape attempt is recorded honestly (including retries and upstream errors)
                    </p>
                  </div>
                  {loadingHistory && <span className="spinner"></span>}
                </div>

                {productHistory.length === 0 ? (
                  <div className="empty-state">
                    <span>No scrape logs recorded for this product yet.</span>
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
                          <th>Attempt Detail / Error Message</th>
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
                              {row.stock !== null ? (
                                row.stock === 0 ? (
                                  <span className="badge badge-danger">Sold Out (0)</span>
                                ) : (
                                  <span className="pill-stock">{row.stock} in stock</span>
                                )
                              ) : (
                                '—'
                              )}
                            </td>
                            <td>
                              <span className="detail-text" title={row.detail || 'Completed'}>
                                {row.detail || (row.outcome === 'success' ? 'Price and stock verified' : '—')}
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

// Lightweight, dependency-free interactive SVG Line Chart
function SimpleLineChart({ data }) {
  if (!data || data.length < 2) return null;

  const width = 760;
  const height = 180;
  const padding = { top: 20, right: 30, bottom: 30, left: 60 };

  const prices = data.map((d) => d.price);
  const minPrice = Math.min(...prices) * 0.95;
  const maxPrice = Math.max(...prices) * 1.05;
  const priceRange = maxPrice - minPrice || 1;

  const getX = (index) => {
    return padding.left + (index / (data.length - 1)) * (width - padding.left - padding.right);
  };

  const getY = (price) => {
    return height - padding.bottom - ((price - minPrice) / priceRange) * (height - padding.top - padding.bottom);
  };

  const points = data.map((d, i) => `${getX(i)},${getY(d.price)}`).join(' ');

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg">
      <defs>
        <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.0" />
        </linearGradient>
      </defs>

      {/* Grid Lines */}
      <line x1={padding.left} y1={padding.top} x2={width - padding.right} y2={padding.top} stroke="#334155" strokeDasharray="3 3" />
      <line x1={padding.left} y1={height / 2} x2={width - padding.right} y2={height / 2} stroke="#334155" strokeDasharray="3 3" />
      <line x1={padding.left} y1={height - padding.bottom} x2={width - padding.right} y2={height - padding.bottom} stroke="#334155" />

      {/* Y Axis labels */}
      <text x={padding.left - 10} y={padding.top + 4} fill="#94a3b8" fontSize="10" textAnchor="end">
        {formatCurrency(Math.round(maxPrice))}
      </text>
      <text x={padding.left - 10} y={height - padding.bottom} fill="#94a3b8" fontSize="10" textAnchor="end">
        {formatCurrency(Math.round(minPrice))}
      </text>

      {/* Fill Area */}
      <polygon
        points={`${padding.left},${height - padding.bottom} ${points} ${width - padding.right},${height - padding.bottom}`}
        fill="url(#chartGradient)"
      />

      {/* Trend Line */}
      <polyline
        fill="none"
        stroke="#3b82f6"
        strokeWidth="2.5"
        points={points}
      />

      {/* Data Points */}
      {data.map((d, i) => (
        <g key={i}>
          <circle
            cx={getX(i)}
            cy={getY(d.price)}
            r="4"
            fill="#1e293b"
            stroke="#3b82f6"
            strokeWidth="2"
          />
        </g>
      ))}
    </svg>
  );
}
