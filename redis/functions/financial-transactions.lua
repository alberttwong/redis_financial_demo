#!lua name=financial_transactions

local function decode_json(value, label)
  local ok, decoded = pcall(cjson.decode, value)
  if not ok then
    error(label .. " must be valid JSON")
  end
  return decoded
end

local function require_non_empty_string(document, field, label)
  local value = document[field]
  if type(value) ~= "string" or value == "" then
    error(label .. "." .. field .. " must be a non-empty string")
  end
  return value
end

local function require_number(document, field, label)
  local value = document[field]
  if type(value) ~= "number" then
    error(label .. "." .. field .. " must be a number")
  end
  return value
end

local function root_document(raw, label)
  local decoded = decode_json(raw, label)
  if type(decoded) ~= "table" or type(decoded[1]) ~= "table" then
    error(label .. " must contain one JSON object")
  end
  return decoded[1]
end

local function hash_tag(key)
  return string.match(key, "{([^{}]+)}")
end

local function projection_version(position, label)
  local value = position.projection_version
  if value == nil then
    return 0
  end
  if type(value) ~= "number" or value < 0 then
    error(label .. ".projection_version must be a non-negative number")
  end
  return value
end

local function position_projection(position, security_id)
  if position == nil then
    return cjson.null
  end

  local resolved_security_id = position.security_id or security_id
  if type(resolved_security_id) ~= "string" or resolved_security_id == "" then
    error("position.security_id must be a non-empty string")
  end

  return {
    _id = require_non_empty_string(position, "_id", "position"),
    account_id = require_non_empty_string(position, "account_id", "position"),
    security_id = resolved_security_id,
    security_no = require_non_empty_string(position, "security_no", "position"),
    acct_type_code = require_non_empty_string(position, "acct_type_code", "position"),
    quantity = require_number(position, "quantity", "position"),
    market_value = require_number(position, "market_value", "position"),
    as_of_date = require_non_empty_string(position, "as_of_date", "position"),
    projection_version = projection_version(position, "position")
  }
end

local function validate_position_identity(position, transaction, label, allow_missing_security_id)
  if require_non_empty_string(position, "account_id", label) ~= transaction.account_id then
    error(label .. ".account_id does not match transaction.account_id")
  end
  if position.security_id == nil and allow_missing_security_id then
    -- Historical position rows predate security_id denormalization. The function
    -- backfills it after validating the other identity fields.
  elseif require_non_empty_string(position, "security_id", label) ~= transaction.security_id then
    error(label .. ".security_id does not match transaction.security_id")
  end
  if require_non_empty_string(position, "security_no", label) ~= transaction.security_no then
    error(label .. ".security_no does not match transaction.security_no")
  end
  if require_non_empty_string(position, "acct_type_code", label) ~= transaction.acct_type_code then
    error(label .. ".acct_type_code does not match transaction.acct_type_code")
  end
end

local function quantity_delta(transaction)
  local transaction_type = string.upper(require_non_empty_string(transaction, "transaction_type", "transaction"))
  local quantity = require_number(transaction, "quantity", "transaction")
  if quantity <= 0 then
    error("transaction.quantity must be greater than zero")
  end

  if transaction_type == "BUY" then
    return quantity
  end
  if transaction_type == "SELL" then
    return -quantity
  end
  if
    transaction_type == "DIVIDEND" or
    transaction_type == "INTEREST" or
    transaction_type == "TRANSFER" or
    transaction_type == "FEE"
  then
    return 0
  end

  error("unsupported transaction.transaction_type: " .. transaction_type)
end

redis.register_function("apply_transaction", function(keys, args)
  if #keys ~= 2 then
    error("apply_transaction requires transaction and position keys")
  end
  if #args ~= 2 then
    error("apply_transaction requires transaction and position-template JSON arguments")
  end

  local transaction_key = keys[1]
  local position_key = keys[2]
  local transaction_tag = hash_tag(transaction_key)
  local position_tag = hash_tag(position_key) or position_key
  if transaction_tag == nil or position_tag == nil or transaction_tag ~= position_tag then
    error("transaction and position keys must use the same Redis Cluster hash tag")
  end

  local transaction = decode_json(args[1], "transaction")
  require_non_empty_string(transaction, "_id", "transaction")
  require_non_empty_string(transaction, "transaction_id", "transaction")
  require_non_empty_string(transaction, "account_id", "transaction")
  require_non_empty_string(transaction, "security_id", "transaction")
  require_non_empty_string(transaction, "security_no", "transaction")
  require_non_empty_string(transaction, "trade_date", "transaction")
  require_non_empty_string(transaction, "acct_type_code", "transaction")
  require_number(transaction, "amount", "transaction")
  local delta = quantity_delta(transaction)

  if redis.call("EXISTS", transaction_key) == 1 then
    local existing_position = nil
    if redis.call("EXISTS", position_key) == 1 then
      existing_position = root_document(redis.call("JSON.GET", position_key, "$"), "position")
    end
    local existing_projection = position_projection(existing_position, transaction.security_id)
    return cjson.encode({
      status = "duplicate",
      quantity_delta = 0,
      position_quantity = existing_position and existing_position.quantity or cjson.null,
      position_projection = existing_projection
    })
  end

  local position_template = decode_json(args[2], "position_template")
  validate_position_identity(position_template, transaction, "position_template", false)
  require_non_empty_string(position_template, "_id", "position_template")
  require_number(position_template, "quantity", "position_template")
  require_number(position_template, "market_value", "position_template")
  require_non_empty_string(position_template, "as_of_date", "position_template")
  projection_version(position_template, "position_template")

  local position_exists = redis.call("EXISTS", position_key) == 1
  local current_position = nil
  if position_exists then
    current_position = root_document(redis.call("JSON.GET", position_key, "$"), "position")
    validate_position_identity(current_position, transaction, "position", true)
    require_number(current_position, "quantity", "position")
    require_number(current_position, "market_value", "position")
    require_non_empty_string(current_position, "as_of_date", "position")
  end

  redis.call("JSON.SET", transaction_key, "$", args[1], "NX")

  local updated_quantity = cjson.null
  local updated_position = nil
  if position_exists then
    if current_position.security_id == nil then
      redis.call("JSON.SET", position_key, ".security_id", cjson.encode(transaction.security_id))
      current_position.security_id = transaction.security_id
    end
    if delta ~= 0 then
      updated_quantity = tonumber(redis.call("JSON.NUMINCRBY", position_key, ".quantity", delta))
      current_position.quantity = updated_quantity
    else
      updated_quantity = current_position.quantity
    end

    if transaction.trade_date > current_position.as_of_date then
      redis.call("JSON.SET", position_key, ".as_of_date", cjson.encode(transaction.trade_date))
      current_position.as_of_date = transaction.trade_date
    end

    current_position.projection_version = projection_version(current_position, "position") + 1
    redis.call("JSON.SET", position_key, ".projection_version", current_position.projection_version)
    updated_position = current_position
  elseif delta ~= 0 then
    position_template.quantity = delta
    position_template.as_of_date = transaction.trade_date
    position_template.projection_version = 1
    redis.call("JSON.SET", position_key, "$", cjson.encode(position_template), "NX")
    updated_quantity = delta
    updated_position = position_template
  end

  return cjson.encode({
    status = "inserted",
    quantity_delta = delta,
    position_quantity = updated_quantity,
    position_projection = position_projection(updated_position, transaction.security_id)
  })
end)

local function read_array(key, path, label)
  local raw = redis.call("JSON.GET", key, path)
  local decoded = decode_json(raw, label)
  if type(decoded) ~= "table" then
    error(label .. " must be an array")
  end
  return decoded
end

redis.register_function("update_account_snapshot", function(keys, args)
  if #keys ~= 1 then
    error("update_account_snapshot requires one account snapshot key")
  end
  if #args ~= 4 then
    error("update_account_snapshot requires transaction, position, security, and generated-at arguments")
  end

  local snapshot_key = keys[1]
  if redis.call("EXISTS", snapshot_key) == 0 then
    return cjson.encode({
      status = "missing",
      transaction_added = false,
      position_updated = false
    })
  end

  local transaction = decode_json(args[1], "transaction")
  local position = decode_json(args[2], "position")
  local security = decode_json(args[3], "security")
  local generated_at = args[4]
  local account_id = require_non_empty_string(transaction, "account_id", "transaction")
  local transaction_id = require_non_empty_string(transaction, "transaction_id", "transaction")
  local transaction_security_id = require_non_empty_string(transaction, "security_id", "transaction")
  local transaction_security_no = require_non_empty_string(transaction, "security_no", "transaction")
  if type(generated_at) ~= "string" or generated_at == "" then
    error("generated_at must be a non-empty string")
  end

  local stored_account_id = decode_json(redis.call("JSON.GET", snapshot_key, ".account_id"), "snapshot.account_id")
  if stored_account_id ~= account_id then
    error("snapshot.account_id does not match transaction.account_id")
  end

  local position_updated = false
  if position ~= cjson.null then
    if require_non_empty_string(position, "account_id", "position") ~= account_id then
      error("position.account_id does not match transaction.account_id")
    end
    local incoming_id = require_non_empty_string(position, "_id", "position")
    if require_non_empty_string(position, "security_id", "position") ~= transaction_security_id then
      error("position.security_id does not match transaction.security_id")
    end
    if require_non_empty_string(position, "security_no", "position") ~= transaction_security_no then
      error("position.security_no does not match transaction.security_no")
    end
    if require_non_empty_string(security, "security_id", "security") ~= transaction_security_id then
      error("security.security_id does not match transaction.security_id")
    end
    if require_non_empty_string(security, "security_no", "security") ~= transaction_security_no then
      error("security.security_no does not match transaction.security_no")
    end
    local incoming_version = projection_version(position, "position")
    local incoming_market_value = require_number(position, "market_value", "position")
    require_number(position, "quantity", "position")
    require_non_empty_string(position, "as_of_date", "position")
    position.security = security

    local positions = read_array(snapshot_key, ".positions", "snapshot.positions")
    local position_index = nil
    local existing_position = nil
    for index, candidate in ipairs(positions) do
      if candidate._id == incoming_id then
        position_index = index - 1
        existing_position = candidate
        break
      end
    end

    if position_index == nil then
      redis.call("JSON.ARRAPPEND", snapshot_key, ".positions", cjson.encode(position))
      redis.call("JSON.NUMINCRBY", snapshot_key, ".position_count", 1)
      if incoming_market_value ~= 0 then
        redis.call("JSON.NUMINCRBY", snapshot_key, ".total_market_value", incoming_market_value)
      end
      position_updated = true
    else
      local existing_version = projection_version(existing_position, "snapshot.position")
      if incoming_version >= existing_version then
        local existing_market_value = require_number(existing_position, "market_value", "snapshot.position")
        redis.call("JSON.SET", snapshot_key, ".positions[" .. position_index .. "]", cjson.encode(position))
        local market_value_delta = incoming_market_value - existing_market_value
        if market_value_delta ~= 0 then
          redis.call("JSON.NUMINCRBY", snapshot_key, ".total_market_value", market_value_delta)
        end
        position_updated = true
      end
    end
  end

  local recent_transactions = read_array(snapshot_key, ".recent_transactions", "snapshot.recent_transactions")
  local transaction_added = true
  for _, candidate in ipairs(recent_transactions) do
    if candidate.transaction_id == transaction_id then
      transaction_added = false
      break
    end
  end

  if transaction_added then
    redis.call("JSON.ARRINSERT", snapshot_key, ".recent_transactions", 0, cjson.encode(transaction))
    redis.call("JSON.ARRTRIM", snapshot_key, ".recent_transactions", 0, 199)
    redis.call("JSON.NUMINCRBY", snapshot_key, ".transaction_count", 1)
  end
  redis.call("JSON.SET", snapshot_key, ".generated_at", cjson.encode(generated_at))

  return cjson.encode({
    status = "updated",
    transaction_added = transaction_added,
    position_updated = position_updated
  })
end)
