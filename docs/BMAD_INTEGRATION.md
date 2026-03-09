# BMAD-METHOD Entegrasyonu — Swingg Trading Bot

## Genel Bakış

Bu proje **BMAD-METHOD v6** platformunu kullanarak 14 uzman AI ajanıyla yönetilmektedir.
Her ajan kendi uzmanlık alanında çalışır, birbirleriyle tartışır ve koordineli şekilde
trading botunun karlılığını artırır.

---

## Kurulum

- **Versiyon:** BMad Method v6.0.4
- **Modül:** BMM + özel Swingg ajanları
- **Araç:** Claude Code
- **Dil:** Türkçe
- **Kurulum:** `_bmad/` dizini

---

## 14 Ajan Ekosistemi

### Katman 1: Liderlik & Koordinasyon

| Ajan | Komut | Görev |
|------|-------|-------|
| 🎯 **TradingPM** | `/trading-pm` | Karlılık analizi, yol haritası, tüm ajanları koordine eder. **Buradan başla.** |

### Katman 2: Piyasa İstihbaratı

| Ajan | Komut | Görev |
|------|-------|-------|
| 📡 **MetricsOrchestrator** | `/metrics-orchestrator` | Metrik hesaplama pipeline sırası, veri tazeliği, NaN guard, bağımlılık grafiği |
| 🔬 **MicrostructureAnalyst** | `/microstructure-analyst` | OBI, Delta Z-Score, CVD Slope, Sweep, Absorption, VPIN hesaplama doğruluğu |
| 🌊 **RegimeEngine** | `/regime-engine` | TREND/RANGING/VOLATILE rejim tespiti, ATR bazlı stop, volatilite ölçümü |
| 🤝 **ConsensusArchitect** | `/consensus-architect` | Çoklu sinyal uzlaşması, korelasyon tespiti, veto mantığı |

### Katman 3: Strateji

| Ajan | Komut | Görev |
|------|-------|-------|
| 📈 **StrategyDesigner** | `/strategy-designer` | NewStrategyV11 optimizasyonu, giriş/çıkış sinyalleri, profit-lock, scale-in |

### Katman 4: Risk Yönetimi

| Ajan | Komut | Görev |
|------|-------|-------|
| 🛡️ **RiskGuardian** | `/risk-guardian` | S1-S5 saldırı senaryoları, Kill Switch, AntiSpoofGuard, FlashCrashGuard |
| 📉 **DrawdownManager** | `/drawdown-manager` | Günlük kayıp limitleri, ardışık kayıp takibi, pozisyon boyutu yönetimi |

### Katman 5: Yürütme & Analitik

| Ajan | Komut | Görev |
|------|-------|-------|
| ⚡ **ExecutionEngineer** | `/execution-engineer` | PlanRunner, slippage, emir tipleri, dolum kalitesi, freeze kontrolü |
| 📊 **QuantAnalyst** | `/quant-analyst` | P&L doğrulama, Sharpe Ratio, Drawdown hesaplaması, backtest kanıtı |
| 🧪 **BacktestEngineer** | `/backtest-engineer` | Walk-forward analizi, Monte Carlo, overfitting tespiti, canlıya geçiş onayı |

### Katman 6: Geliştirme

| Ajan | Komut | Görev |
|------|-------|-------|
| 💻 **BackendDev** | `/backend-dev` | Node.js/TypeScript implementasyonu, endpoint, WebSocket, test yazımı |
| 🏗️ **SystemArchitect** | `/system-architect` | API kablolama, mimari bütünlük, polling hooks, TypeScript kalitesi |
| 🎨 **FrontendDev** | `/frontend-dev` | React dashboard, gerçek zamanlı metrikler, error boundary, UI/UX |

---

## Konsey Modu (Party Mode)

Tüm 14 ajanı aynı anda aktive etmek için:

```
/swingg-council
```

Ajanlar birbirleriyle tartışır, veto hakkı kullanır ve ortak karar alır.

### Oylama Protokolü

**Bloker Ajanlar** (herhangi biri HAYIR derse → bloke):
- 🛡️ RiskGuardian
- 📉 DrawdownManager
- 🧪 BacktestEngineer

**Danışman Ajanlar** (ağırlıklı oy, >%50 gerekli):
- 📈 StrategyDesigner (3 oy)
- 📡 MetricsOrchestrator (2 oy)
- 🌊 RegimeEngine (2 oy)
- 📊 QuantAnalyst (2 oy)
- ⚡ ExecutionEngineer (1 oy)
- 🤝 ConsensusArchitect (1 oy)

---

## Aktif Sorunlar (Karlılık Önceliği)

| # | Sorun | Öncelik | Ajanlar |
|---|-------|---------|---------|
| P1 | RANGING rejimde whipsaw kayıplar | 🔴 KRİTİK | RegimeEngine + StrategyDesigner |
| P2 | Metrik orkestrasyon sırası hatalı | 🔴 KRİTİK | MetricsOrchestrator |
| P3 | Profit-lock volatiliteye duyarsız | 🟡 YÜKSEK | StrategyDesigner + QuantAnalyst |
| P4 | Scale-in zarar eden pozisyona para ekliyor | 🟡 YÜKSEK | DrawdownManager + ExecutionEngineer |
| P5 | Stop-loss sabit %, ATR bazlı değil | 🟡 YÜKSEK | StrategyDesigner + RegimeEngine |
| P6 | Slippage tahmini yok | 🟠 ORTA | ExecutionEngineer |
| P7 | Frontend metrikleri gecikiyor | 🟠 ORTA | FrontendDev |

---

## Hızlı Başlangıç

```
# Genel yol haritası için:
/trading-pm

# Belirli soruna için:
/regime-engine          → P1: RANGING whipsaw
/metrics-orchestrator   → P2: Pipeline sırası
/strategy-designer      → P3/P4/P5: Strateji iyileştirme
/execution-engineer     → P6: Slippage
/frontend-dev           → P7: Dashboard

# Tüm ajanları topla:
/swingg-council
```

---

## Dizin Yapısı

```
_bmad/bmm/agents/
├── trading-pm.md           🎯 Koordinatör
├── metrics-orchestrator.md 📡 Pipeline şefi
├── microstructure-analyst.md 🔬 OBI/Delta/CVD
├── regime-engine.md        🌊 Rejim tespiti
├── strategy-designer.md    📈 Strateji
├── consensus-architect.md  🤝 Uzlaşma
├── risk-guardian.md        🛡️ Güvenlik
├── drawdown-manager.md     📉 Kayıp yönetimi
├── execution-engineer.md   ⚡ Yürütme
├── quant-analyst.md        📊 Analitik
├── backtest-engineer.md    🧪 Test/Validasyon
├── backend-dev.md          💻 Backend kod
├── system-architect.md     🏗️ Mimari
└── frontend-dev.md         🎨 Dashboard

_bmad/bmm/teams/
└── swingg-trading-council.md  👥 Party Mode protokolü

_bmad-output/
├── planning-artifacts/     PRD, sprint planları
└── implementation-artifacts/ Hikayeler, teknik notlar
```

---

## Entegrasyon Durumu

- [x] BMAD-METHOD v6 kurulumu
- [x] 14 uzman ajan tanımı (11 yeni + 3 mevcut)
- [x] Claude Code slash commands (14 ajan + 1 konsey)
- [x] Party Mode konsey protokolü
- [x] Türkçe dil konfigürasyonu
- [x] 7 kritik karlılık sorunu dokümantasyonu
- [ ] P1: RANGING whipsaw düzeltmesi (aktif çalışma)
- [ ] P2: Metrik pipeline yeniden sıralama
- [ ] P3-P5: Strateji iyileştirmeleri
