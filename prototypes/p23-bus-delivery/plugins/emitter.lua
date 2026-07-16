-- p23 plugin "beta" (emitter.lua): the emitting plugin (plus a few subs so
-- registration order interleaves across plugin domains).

-- order ----------------------------------------------------------------------

function setup_order_second()
  smith.bus.on("acme/order", function(p) smith.log("sub2 count=" .. p.count) end)
end

function emit_order(n)
  smith.log("before emit count=" .. n)
  smith.bus.emit("acme/order", { count = n, tags = { "x", "y" } })
  smith.log("after emit count=" .. n .. " (emit returned synchronously)")
end

-- reentrancy -----------------------------------------------------------------

function setup_reentry_same_second()
  smith.bus.on("acme/ping", function(p) smith.log("R2 n=" .. p.n) end)
end

function emit_ping()
  smith.bus.emit("acme/ping", { n = 1 })
end

function setup_reentry_cross_second()
  smith.bus.on("acme/a", function(p) smith.log("A2 n=" .. p.n) end)
end

function emit_cross()
  smith.bus.emit("acme/a", { n = 1 })
end

-- error isolation -------------------------------------------------------------

function setup_error_second()
  smith.bus.on("acme/err", function(p)
    error("boom: intentional subscriber failure")
  end)
end

function emit_err()
  smith.bus.emit("acme/err", { v = 5 })
  smith.log("emit returned normally despite subscriber error")
end

-- teardown-mid-dispatch ---------------------------------------------------------

function setup_teardown_second()
  smith.bus.on("acme/reload", function(p)
    smith.log("T2 ran (MUST NOT HAPPEN: domain was retired mid-dispatch)")
  end)
end

-- non-data payload probes: each returns (ok, err) to the host ---------------------

function emit_fn_payload()
  local ok, err = pcall(smith.bus.emit, "acme/data",
    { kind = "fn", fn = function() end })
  return ok, tostring(err)
end

function emit_nested_fn_payload()
  local ok, err = pcall(smith.bus.emit, "acme/data",
    { kind = "nested", meta = { deep = { cb = function() end } } })
  return ok, tostring(err)
end

function emit_thread_payload()
  local ok, err = pcall(smith.bus.emit, "acme/data",
    { kind = "thread", co = coroutine.create(function() end) })
  return ok, tostring(err)
end

function emit_fn_key_payload()
  local ok, err = pcall(smith.bus.emit, "acme/data", { [function() end] = 1 })
  return ok, tostring(err)
end

function emit_cyclic_payload()
  local t = { kind = "cycle" }
  t.self = t
  local ok, err = pcall(smith.bus.emit, "acme/data", t)
  return ok, tostring(err)
end

function emit_bad_topic()
  local ok, err = pcall(smith.bus.emit, "Acme/Data!", { kind = "x" })
  return ok, tostring(err)
end

function emit_unnamespaced_topic()
  local ok, err = pcall(smith.bus.emit, "no-namespace", { kind = "x" })
  return ok, tostring(err)
end

function on_bad_topic()
  local ok, err = pcall(smith.bus.on, "BAD/x", function() end)
  return ok, tostring(err)
end

function emit_good_payload()
  smith.bus.emit("acme/data",
    { kind = "good", nested = { list = { 1, 2, 3 }, flag = true } })
end
