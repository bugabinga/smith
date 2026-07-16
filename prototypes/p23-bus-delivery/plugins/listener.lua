-- p23 plugin "alpha" (listener.lua): the subscription-heavy plugin.
-- The host drives scenarios by calling these globals; all bus traffic goes
-- through smith.bus.on/emit/off (SPEC §9.18).

local handles = {}

-- order ----------------------------------------------------------------------

function setup_order_first()
  handles.sub1 = smith.bus.on("acme/order", function(p)
    smith.log("sub1 count=" .. p.count .. " tag2=" .. p.tags[2])
  end)
end

function setup_order_third()
  handles.sub3 = smith.bus.on("acme/order", function(p)
    smith.log("sub3 count=" .. p.count)
  end)
end

function drop_sub3()
  smith.log("off(sub3)=" .. tostring(smith.bus.off(handles.sub3)))
end

-- reentrancy -----------------------------------------------------------------

function setup_reentry_same()
  smith.bus.on("acme/ping", function(p)
    smith.log("R1 n=" .. p.n)
    if p.n == 1 then
      smith.bus.emit("acme/ping", { n = 2 })
      smith.log("R1 inner emit returned (enqueued, not re-entered)")
    end
  end)
end

function setup_reentry_cross()
  smith.bus.on("acme/a", function(p)
    smith.log("A1 n=" .. p.n)
    if p.n == 1 then
      smith.bus.emit("acme/b", { from = "A1" })
      smith.bus.emit("acme/a", { n = 2 })
    end
  end)
  smith.bus.on("acme/b", function(p)
    smith.log("B1 from=" .. p.from)
  end)
end

-- error isolation -------------------------------------------------------------

function setup_error_first()
  smith.bus.on("acme/err", function(p) smith.log("E1 got " .. p.v) end)
end

function setup_error_third()
  smith.bus.on("acme/err", function(p) smith.log("E3 got " .. p.v) end)
end

-- teardown-mid-dispatch ---------------------------------------------------------

function setup_teardown_first()
  smith.bus.on("acme/reload", function(p)
    smith.log("T1 start")
    smith.test.teardown("beta")
    smith.log("T1 end (teardown of beta requested mid-dispatch)")
  end)
end

function emit_reload()
  smith.bus.emit("acme/reload", { reason = "test" })
  smith.log("emit_reload returned")
end

function setup_self_teardown()
  smith.bus.on("acme/self", function(p)
    smith.log("S1 requesting teardown of own domain")
    smith.test.teardown("alpha")
    smith.log("S1 still executing safely after own teardown request")
  end)
  smith.bus.on("acme/self", function(p)
    smith.log("S2 ran (MUST NOT HAPPEN: own domain was retired)")
  end)
end

-- non-data payloads -------------------------------------------------------------

function setup_data_canary()
  smith.bus.on("acme/data", function(p)
    smith.log("canary got kind=" .. p.kind
      .. " list_len=" .. #p.nested.list
      .. " flag=" .. tostring(p.nested.flag))
  end)
end
