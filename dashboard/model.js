(function () {
  "use strict";

  // Fit log10(mcap / TVL) against log10(TVL) using this snapshot's live tokens.
  function fitSizeCurve(liveProtocols) {
    var points = [];

    liveProtocols.forEach(function (protocol) {
      var tvl = protocol.tvl_usd;
      var mcap = protocol.mcap_usd;
      if (
        typeof tvl !== "number" ||
        typeof mcap !== "number" ||
        !Number.isFinite(tvl) ||
        !Number.isFinite(mcap) ||
        tvl <= 0 ||
        mcap <= 0
      ) {
        return;
      }
      points.push({
        x: Math.log10(tvl),
        y: Math.log10(mcap / tvl),
      });
    });

    var n = points.length;
    if (n < 10) {
      return {
        intercept: 3.0247,
        slope: -0.4777,
        n: n,
        clampMin: 0.02,
        clampMax: 0.8,
      };
    }

    var meanX = points.reduce(function (sum, point) {
      return sum + point.x;
    }, 0) / n;
    var meanY = points.reduce(function (sum, point) {
      return sum + point.y;
    }, 0) / n;
    var covariance = 0;
    var varianceX = 0;

    points.forEach(function (point) {
      var dx = point.x - meanX;
      covariance += dx * (point.y - meanY);
      varianceX += dx * dx;
    });

    var slope = varianceX === 0 ? 0 : covariance / varianceX;
    return {
      intercept: meanY - slope * meanX,
      slope: slope,
      n: n,
      clampMin: 0.02,
      clampMax: 0.8,
    };
  }

  // Clamp guards against implausibly tiny or huge fitted multiples.
  function sizeMultiple(tvl, curve) {
    if (typeof tvl !== "number" || !Number.isFinite(tvl) || tvl <= 0) {
      return curve.clampMin;
    }
    var fitted = Math.pow(10, curve.intercept + curve.slope * Math.log10(tvl));
    return Math.min(curve.clampMax, Math.max(curve.clampMin, fitted));
  }

  // Cap seven-day growth at plus or minus 30 percentage points.
  function growthMultiplier(change7d) {
    var change = typeof change7d === "number" && Number.isFinite(change7d)
      ? change7d
      : 0;
    return 1 + Math.min(30, Math.max(-30, change)) / 100;
  }

  // Maturity rises linearly from 0.7 to 1.0 over three years.
  function maturityMultiplier(ageDays) {
    var age = typeof ageDays === "number" && Number.isFinite(ageDays)
      ? ageDays
      : 365;
    return 0.7 + 0.3 * Math.min(age, 1095) / 1095;
  }

  // Apply the 0.75 pre-token haircut before rounding to whole dollars.
  function impliedValue(protocol, curve) {
    var tvl = Number.isFinite(protocol.tvl_usd) && protocol.tvl_usd > 0
      ? protocol.tvl_usd
      : 0;
    return Math.max(
      1,
      Math.round(
        tvl *
          sizeMultiple(tvl, curve) *
          0.75 *
          growthMultiplier(protocol.change_7d) *
          maturityMultiplier(protocol.age_days)
      )
    );
  }

  // 5-fold cross-validation on the snapshot's live tokens: fold of point i
  // is i mod 5 (snapshot order), errors pooled across folds. Compares the
  // size curve against a flat global median multiple, in |log10 error|.
  function backtest(liveProtocols) {
    var usable = [];
    var i;
    var fold;
    var training;
    var trainingLogs;
    var curveErrors = [];
    var flatErrors = [];
    var actual;
    var predicted;
    var flat;
    var middle;
    var errorMiddle;

    for (i = 0; i < liveProtocols.length; i += 1) {
      var protocol = liveProtocols[i];
      if (
        !Number.isFinite(protocol.tvl_usd) ||
        protocol.tvl_usd <= 0 ||
        !Number.isFinite(protocol.mcap_usd) ||
        protocol.mcap_usd <= 0
      ) {
        continue;
      }
      usable.push(protocol);
    }

    var n = usable.length;
    if (n < 10) {
      return { curve: null, flat: null, n: n };
    }

    for (fold = 0; fold < 5; fold += 1) {
      training = [];
      trainingLogs = [];

      for (i = 0; i < n; i += 1) {
        if (i % 5 !== fold) {
          training.push(usable[i]);
          trainingLogs.push(
            Math.log10(usable[i].mcap_usd / usable[i].tvl_usd)
          );
        }
      }

      trainingLogs.sort(function (a, b) {
        return a - b;
      });
      middle = Math.floor(trainingLogs.length / 2);
      flat = trainingLogs.length % 2
        ? trainingLogs[middle]
        : (trainingLogs[middle - 1] + trainingLogs[middle]) / 2;

      var foldCurve = fitSizeCurve(training);
      for (i = 0; i < n; i += 1) {
        if (i % 5 === fold) {
          actual = Math.log10(usable[i].mcap_usd / usable[i].tvl_usd);
          predicted = Math.log10(sizeMultiple(usable[i].tvl_usd, foldCurve));
          curveErrors.push(Math.abs(predicted - actual));
          flatErrors.push(Math.abs(flat - actual));
        }
      }
    }

    curveErrors.sort(function (a, b) {
      return a - b;
    });
    flatErrors.sort(function (a, b) {
      return a - b;
    });
    errorMiddle = Math.floor(curveErrors.length / 2);

    return {
      curve: curveErrors.length % 2
        ? curveErrors[errorMiddle]
        : (curveErrors[errorMiddle - 1] + curveErrors[errorMiddle]) / 2,
      flat: flatErrors.length % 2
        ? flatErrors[errorMiddle]
        : (flatErrors[errorMiddle - 1] + flatErrors[errorMiddle]) / 2,
      n: n
    };
  }

  // Median mcap/TVL multiple for one category over live tokens (mcap > 0,
  // tvl > 0). Odd count takes the middle value, even count the mean of the
  // two central raw multiples. Returns null when the category has no live
  // peers. Same rule as lib/model.ts categoryMedians, for one category.
  function categoryMedian(liveProtocols, category) {
    var values = [];

    if (typeof category !== "string") {
      return null;
    }

    liveProtocols.forEach(function (protocol) {
      var tvl = protocol.tvl_usd;
      var mcap = protocol.mcap_usd;
      if (protocol.category !== category) {
        return;
      }
      if (
        typeof tvl !== "number" ||
        typeof mcap !== "number" ||
        !Number.isFinite(tvl) ||
        !Number.isFinite(mcap) ||
        tvl <= 0 ||
        mcap <= 0
      ) {
        return;
      }
      values.push(mcap / tvl);
    });

    if (values.length === 0) {
      return null;
    }

    values.sort(function (a, b) {
      return a - b;
    });
    var mid = Math.floor(values.length / 2);
    var median = values.length % 2 === 1
      ? values[mid]
      : (values[mid - 1] + values[mid]) / 2;
    return { median: median, peers: values.length };
  }

  // Conviction: how much evidence backs a row's implied value, 0-100.
  // Five legs, same math as lib/model.ts convictionLegs. catMedian is the
  // category's live median multiple (null when no live peers) and catPeers
  // the live peer count. The total is the leg sum, clamped to 0-100; the
  // leg maxima sum to exactly 100, so the clamp never binds on valid input.
  // Conviction never changes the implied value or the rank.
  function convictionLegs(row, boardLogMin, boardLogMax, catMedian, catPeers) {
    var scale;
    if (
      !Number.isFinite(row.tvl_usd) ||
      row.tvl_usd <= 0 ||
      !Number.isFinite(boardLogMin) ||
      !Number.isFinite(boardLogMax)
    ) {
      scale = 0;
    } else if (boardLogMax - boardLogMin <= 0) {
      // Degenerate board (all rows the same TVL): neutral midpoint.
      scale = 13;
    } else {
      scale = Math.round(
        (25 * (Math.log10(row.tvl_usd) - boardLogMin)) /
          (boardLogMax - boardLogMin)
      );
    }
    scale = Math.min(25, Math.max(0, scale));

    var momentum;
    if (typeof row.change_7d === "number" && Number.isFinite(row.change_7d)) {
      momentum = Math.round(
        10 + Math.min(30, Math.max(-30, row.change_7d)) / 3
      );
    } else {
      momentum = 10;
    }
    momentum = Math.min(20, Math.max(0, momentum));

    var age = row.age_days === null || row.age_days === undefined
      ? 365
      : row.age_days;
    var maturity = Math.round(
      (20 * Math.min(Math.max(age, 0), 1095)) / 1095
    );

    var peersCount = typeof catPeers === "number" && Number.isFinite(catPeers)
      ? catPeers
      : 0;
    var peers = peersCount === 0
      ? 0
      : peersCount <= 2
        ? 7
        : peersCount <= 5
          ? 13
          : 20;

    var agreement;
    if (
      !Number.isFinite(catMedian) ||
      catMedian <= 0 ||
      !Number.isFinite(row.size_multiple) ||
      row.size_multiple <= 0
    ) {
      agreement = 8;
    } else {
      var d = Math.abs(
        Math.log10(row.size_multiple) - Math.log10(catMedian)
      );
      agreement = d <= 0.1 ? 15 : d <= 0.25 ? 11 : d <= 0.4 ? 7 : 3;
    }

    var total = Math.min(
      100,
      Math.max(0, scale + momentum + maturity + peers + agreement)
    );
    return {
      scale: scale,
      momentum: momentum,
      maturity: maturity,
      peers: peers,
      agreement: agreement,
      total: total,
    };
  }

  // Group the board rows into four Conviction bands and summarise each one:
  // how many rows it holds, the median implied value of its rows in whole
  // dollars (null when the band is empty), and the row with the largest
  // implied value in the band (ties broken by the lowest rank). Bands are
  // >=65, 50-64, 40-49 and <40. Pure function: it reads only row fields.
  function convictionBands(rows) {
    var defs = [
      { label: "\u226565", min: 65, max: 101 },
      { label: "50\u201364", min: 50, max: 65 },
      { label: "40\u201349", min: 40, max: 50 },
      { label: "<40", min: 0, max: 40 },
    ];
    var list = Array.isArray(rows) ? rows : [];
    return defs.map(function (def) {
      var members = list.filter(function (row) {
        return typeof row.conviction === "number" &&
          Number.isFinite(row.conviction) &&
          row.conviction >= def.min &&
          row.conviction < def.max;
      });
      var values = members
        .map(function (row) {
          return row.implied_value_usd;
        })
        .filter(function (value) {
          return typeof value === "number" && Number.isFinite(value);
        })
        .sort(function (a, b) {
          return a - b;
        });
      var medianImplied = null;
      if (values.length > 0) {
        var middle = Math.floor(values.length / 2);
        medianImplied = values.length % 2 === 1
          ? Math.round(values[middle])
          : Math.round((values[middle - 1] + values[middle]) / 2);
      }
      var top = null;
      members.forEach(function (row) {
        var value = row.implied_value_usd;
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return;
        }
        if (
          top === null ||
          value > top.implied_value_usd ||
          (value === top.implied_value_usd && row.rank < top.rank)
        ) {
          top = row;
        }
      });
      return {
        label: def.label,
        min: def.min,
        max: def.max,
        count: members.length,
        medianImplied: medianImplied,
        topSlug: top === null ? null : top.slug,
        topName: top === null ? null : top.name,
      };
    });
  }

  window.TokenRadarModel = {
    fitSizeCurve: fitSizeCurve,
    sizeMultiple: sizeMultiple,
    growthMultiplier: growthMultiplier,
    maturityMultiplier: maturityMultiplier,
    impliedValue: impliedValue,
    backtest: backtest,
    categoryMedian: categoryMedian,
    convictionLegs: convictionLegs,
    convictionBands: convictionBands,
  };
})();
