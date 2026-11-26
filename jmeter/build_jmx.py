"""Generates jmeter/load.jmx (the JMeter version of k6/load.js).

The .jmx is the file you open in JMeter; this script only exists so that the plan can be
re-generated and reviewed as code. Run: python jmeter/build_jmx.py
"""
from pathlib import Path
from xml.sax.saxutils import escape


def s(name, value):
    return f'<stringProp name="{name}">{escape(str(value))}</stringProp>'


def b(name, value):
    return f'<boolProp name="{name}">{"true" if value else "false"}</boolProp>'


def node(element, children=""):
    """An element followed by its hashTree (JMeter's way of storing children)."""
    return f"{element}\n<hashTree>\n{children}\n</hashTree>"


def leaf(element):
    return f"{element}\n<hashTree/>"


def args(items):
    props = "".join(
        f'<elementProp name="{n}" elementType="Argument">{s("Argument.name", n)}{s("Argument.value", v)}'
        f'{s("Argument.metadata", "=")}</elementProp>'
        for n, v in items
    )
    return props


def http(name, method, path, body=None):
    if body is None:
        arguments = ('<elementProp name="HTTPsampler.Arguments" elementType="Arguments" '
                     'guiclass="HTTPArgumentsPanel" testclass="Arguments"><collectionProp name="Arguments.arguments"/></elementProp>')
        raw = b("HTTPSampler.postBodyRaw", False)
    else:
        arguments = ('<elementProp name="HTTPsampler.Arguments" elementType="Arguments"><collectionProp name="Arguments.arguments">'
                     '<elementProp name="" elementType="HTTPArgument">'
                     f'{b("HTTPArgument.always_encode", False)}{s("Argument.value", body)}{s("Argument.metadata", "=")}'
                     '</elementProp></collectionProp></elementProp>')
        raw = b("HTTPSampler.postBodyRaw", True)
    return (f'<HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="{escape(name)}">'
            f'{raw}{arguments}{s("HTTPSampler.path", path)}{s("HTTPSampler.method", method)}'
            f'{b("HTTPSampler.follow_redirects", True)}{b("HTTPSampler.use_keepalive", True)}'
            '</HTTPSamplerProxy>')


def headers(name, items):
    hs = "".join(f'<elementProp name="" elementType="Header">{s("Header.name", k)}{s("Header.value", v)}</elementProp>'
                 for k, v in items)
    return leaf(f'<HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="{escape(name)}">'
                f'<collectionProp name="HeaderManager.headers">{hs}</collectionProp></HeaderManager>')


def assert_code(code):
    return leaf('<ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="HTTP ' + code + '">'
                f'<collectionProp name="Asserion.test_strings"><stringProp name="0">{code}</stringProp></collectionProp>'
                f'{s("Assertion.custom_message", "")}{s("Assertion.test_field", "Assertion.response_code")}'
                f'{b("Assertion.assume_success", False)}<intProp name="Assertion.test_type">8</intProp>'
                '</ResponseAssertion>')


def json_assert(name, path, expected):
    return leaf(f'<JSONPathAssertion guiclass="JSONPathAssertionGui" testclass="JSONPathAssertion" testname="{escape(name)}">'
                f'{s("JSON_PATH", path)}{s("EXPECTED_VALUE", expected)}{b("JSONVALIDATION", True)}'
                f'{b("EXPECT_NULL", False)}{b("INVERT", False)}{b("ISREGEX", False)}</JSONPathAssertion>')


def json_extract(name, var, path, default="NOT_FOUND"):
    return leaf(f'<JSONPostProcessor guiclass="JSONPostProcessorGui" testclass="JSONPostProcessor" testname="{escape(name)}">'
                f'{s("JSONPostProcessor.referenceNames", var)}{s("JSONPostProcessor.jsonPathExprs", path)}'
                f'{s("JSONPostProcessor.match_numbers", "1")}{s("JSONPostProcessor.defaultValues", default)}'
                '</JSONPostProcessor>')


def groovy(kind, name, script):
    return leaf(f'<{kind} guiclass="TestBeanGUI" testclass="{kind}" testname="{escape(name)}">'
                f'{s("scriptLanguage", "groovy")}{s("parameters", "")}{s("filename", "")}{s("cacheKey", "true")}'
                f'{s("script", script)}</{kind}>')


def controller(cls, gui, name, extra, children):
    return node(f'<{cls} guiclass="{gui}" testclass="{cls}" testname="{escape(name)}">{extra}</{cls}>', children)


def simple(name, children):
    return controller("GenericController", "LogicControllerGui", name, "", children)


def timer(ms):
    return leaf(f'<ConstantTimer guiclass="ConstantTimerGui" testclass="ConstantTimer" testname="Wait {ms} ms">'
                f'{s("ConstantTimer.delay", ms)}</ConstantTimer>')


def classic_group(cls, gui, name, children):
    loop = ('<elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" '
            f'testclass="LoopController">{s("LoopController.loops", "1")}{b("LoopController.continue_forever", False)}</elementProp>')
    return node(f'<{cls} guiclass="{gui}" testclass="{cls}" testname="{escape(name)}">'
                f'{s("ThreadGroup.on_sample_error", "continue")}{loop}{s("ThreadGroup.num_threads", "1")}'
                f'{s("ThreadGroup.ramp_time", "1")}{b("ThreadGroup.same_user_on_next_iteration", True)}</{cls}>', children)


# ------------------------------------------------------------------ the plan
RATE = "${__P(rate,100)}"
DURATION = "${__P(duration,1)}"

setup = classic_group("SetupThreadGroup", "SetupThreadGroupGui", "setUp: reset the bank and get a token",
    node(http("POST /admin/reset", "POST", "/admin/reset"), assert_code("200")) + "\n" +
    node(http("POST /auth/token", "POST", "/auth/token", '{"client_id":"k6-client","client_secret":"s3cr3t"}'),
         assert_code("200") + "\n" +
         json_extract("Extract access_token (correlation)", "TOKEN", "$.access_token") + "\n" +
         groovy("JSR223PostProcessor", "Share the token with all thread groups",
                "// vars are per thread; props are global to the whole test\nprops.put('TOKEN', vars.get('TOKEN'))")))

payment_body = ('{"from":"${FROM}","to":"${TO}","amount":"${__Random(1,49)}.${__Random(10,99)}","currency":"PEN"}')

busy_hour_children = "\n".join([
    headers("Bearer token", [("Authorization", "Bearer ${__P(TOKEN)}")]),
    leaf('<CSVDataSet guiclass="TestBeanGUI" testclass="CSVDataSet" testname="Accounts (CSV test data)">'
         f'{s("filename", "${__P(data,data/accounts.csv)}")}{s("fileEncoding", "UTF-8")}'
         f'{s("variableNames", "")}{b("ignoreFirstLine", False)}{s("delimiter", ",")}{b("quotedData", False)}'
         f'{b("recycle", True)}{b("stopThread", False)}{s("shareMode", "shareMode.all")}</CSVDataSet>'),
    controller("SwitchController", "SwitchControllerGui", "Traffic mix: 60 % balance, 25 % history, 15 % payment",
        s("SwitchController.value",
          "${__groovy(def r = Math.random(); r < 0.60 ? 'balance' : (r < 0.85 ? 'history' : 'payment'))}"),
        "\n".join([
            simple("balance", node(http("GET /accounts/:id", "GET", "/accounts/${FROM}"), assert_code("200"))),
            simple("history", node(http("GET /accounts/:id/transactions", "GET", "/accounts/${FROM}/transactions?limit=20"),
                                   assert_code("200"))),
            simple("payment", node(http("POST /payments", "POST", "/payments", payment_body),
                                   headers("Idempotency-Key", [("Idempotency-Key", "${__UUID()}")]) + "\n" +
                                   assert_code("201") + "\n" +
                                   json_assert("status is PENDING", "$.status", "PENDING"))),
        ])),
])

busy_hour = node(
    '<OpenModelThreadGroup guiclass="OpenModelThreadGroupGui" testclass="OpenModelThreadGroup" '
    'testname="Busy hour: open model, constant arrival rate">'
    '<elementProp name="ThreadGroup.main_controller" elementType="OpenModelThreadGroupController"/>'
    f'{s("ThreadGroup.on_sample_error", "continue")}'
    f'{s("OpenModelThreadGroup.schedule", f"rate({RATE}/sec) random_arrivals({DURATION} min) rate({RATE}/sec)")}'
    f'{s("OpenModelThreadGroup.random_seed", "")}'
    '</OpenModelThreadGroup>',
    busy_hour_children)

teardown = classic_group("PostThreadGroup", "PostThreadGroupGui", "tearDown: reconciliation",
    controller("WhileController", "WhileControllerGui", "Wait for the settlement queue to drain",
        s("WhileController.condition", '${__jexl3("${PENDING}" != "0")}'),
        node(http("GET /admin/reconciliation (polling)", "GET", "/admin/reconciliation"),
             json_extract("Extract pendingSettlements", "PENDING", "$.pendingSettlements", "0") + "\n" + timer(1000))) + "\n" +
    node(http("GET /admin/reconciliation (final check)", "GET", "/admin/reconciliation"),
         json_assert("money conserved (drift = 0)", "$.driftCents", "0") + "\n" +
         json_assert("no negative balance", "$.negativeBalances", "0") + "\n" +
         json_assert("no duplicate payment", "$.duplicatePayments", "0")))

defaults = leaf('<ConfigTestElement guiclass="HttpDefaultsGui" testclass="ConfigTestElement" testname="HTTP Request Defaults">'
                '<elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" '
                'testclass="Arguments"><collectionProp name="Arguments.arguments"/></elementProp>'
                f'{s("HTTPSampler.domain", "${__P(host,localhost)}")}{s("HTTPSampler.port", "${__P(port,3001)}")}'
                f'{s("HTTPSampler.protocol", "http")}{s("HTTPSampler.connect_timeout", "5000")}'
                f'{s("HTTPSampler.response_timeout", "10000")}</ConfigTestElement>')

plan = node(
    '<TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="bank-perf-lab: load test (JMeter version of k6/load.js)">'
    f'{s("TestPlan.comments", "Run: jmeter -n -t jmeter/load.jmx -Jrate=100 -Jduration=1 -l results/load.jtl -e -o results/report")}'
    f'{b("TestPlan.functional_mode", False)}{b("TestPlan.tearDown_on_shutdown", True)}{b("TestPlan.serialize_threadgroups", True)}'
    '<elementProp name="TestPlan.user_defined_variables" elementType="Arguments" guiclass="ArgumentsPanel" '
    'testclass="Arguments" testname="User Defined Variables"><collectionProp name="Arguments.arguments"/></elementProp>'
    f'{s("TestPlan.user_define_classpath", "")}</TestPlan>',
    "\n".join([defaults, headers("JSON content type", [("Content-Type", "application/json")]), setup, busy_hour, teardown]))

xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
       '<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">\n<hashTree>\n' + plan + '\n</hashTree>\n</jmeterTestPlan>\n')
Path(__file__).with_name("load.jmx").write_text(xml, encoding="utf-8")
print("jmeter/load.jmx written")
