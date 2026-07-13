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

local function position_quantity(position_key)
  if redis.call("EXISTS", position_key) == 0 then
    return cjson.null
  end

  local raw = redis.call("JSON.GET", position_key, ".quantity")
  local quantity = tonumber(raw)
  if quantity == nil then
    error("position.quantity must be a number")
  end
  return quantity
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
    return cjson.encode({
      status = "duplicate",
      quantity_delta = 0,
      position_quantity = position_quantity(position_key)
    })
  end

  local position_template = decode_json(args[2], "position_template")
  validate_position_identity(position_template, transaction, "position_template", false)
  require_non_empty_string(position_template, "_id", "position_template")
  require_number(position_template, "quantity", "position_template")
  require_number(position_template, "market_value", "position_template")
  require_non_empty_string(position_template, "as_of_date", "position_template")

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
  if position_exists then
    if current_position.security_id == nil then
      redis.call("JSON.SET", position_key, ".security_id", cjson.encode(transaction.security_id))
    end
    if delta ~= 0 then
      updated_quantity = tonumber(redis.call("JSON.NUMINCRBY", position_key, ".quantity", delta))
    else
      updated_quantity = current_position.quantity
    end

    if transaction.trade_date > current_position.as_of_date then
      redis.call("JSON.SET", position_key, ".as_of_date", cjson.encode(transaction.trade_date))
    end
  elseif delta ~= 0 then
    position_template.quantity = delta
    position_template.as_of_date = transaction.trade_date
    redis.call("JSON.SET", position_key, "$", cjson.encode(position_template), "NX")
    updated_quantity = delta
  end

  return cjson.encode({
    status = "inserted",
    quantity_delta = delta,
    position_quantity = updated_quantity
  })
end)
