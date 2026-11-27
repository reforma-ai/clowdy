#import <AppKit/AppKit.h>
#include <node_api.h>

struct Monitor {
    napi_env env;
    napi_ref callback;
    __strong id token;
    __weak NSView *view;
    NSInteger windowNumber;
    bool stopped;
};

static void stopMonitor(Monitor *monitor) {
    if (monitor->stopped) return;
    monitor->stopped = true;
    if (monitor->token) [NSEvent removeMonitor:monitor->token];
    monitor->token = nil;
    napi_delete_reference(monitor->env, monitor->callback);
}

static void finalize(napi_env, void *data, void *) {
    Monitor *monitor = static_cast<Monitor *>(data);
    stopMonitor(monitor);
    delete monitor;
}

static napi_value stop(napi_env env, napi_callback_info info) {
    void *data;
    napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &data);
    stopMonitor(static_cast<Monitor *>(data));
    return nullptr;
}

static void number(napi_env env, napi_value object, const char *key, double value) {
    napi_value result;
    napi_create_double(env, value, &result);
    napi_set_named_property(env, object, key, result);
}

static napi_value start(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    void *buffer = nullptr;
    size_t length = 0;
    napi_valuetype type;
    if (argc != 2 || napi_get_buffer_info(env, args[0], &buffer, &length) != napi_ok || length != sizeof(void *) ||
        napi_typeof(env, args[1], &type) != napi_ok || type != napi_function) {
        napi_throw_type_error(env, nullptr, "Expected a window handle and callback");
        return nullptr;
    }
    NSView *view = (__bridge NSView *)*(void **)buffer;
    NSWindow *window = view.window;
    if (!window) {
        napi_throw_error(env, nullptr, "Window is unavailable");
        return nullptr;
    }
    Monitor *monitor = new Monitor{env, nullptr, nil, view, window.windowNumber, false};
    napi_create_reference(env, args[1], 1, &monitor->callback);
    monitor->token = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel handler:^NSEvent *(NSEvent *event) {
        NSView *target = monitor->view;
        if (monitor->stopped || !target || event.windowNumber != monitor->windowNumber || target.window != event.window) return event;
        NSPoint point = [target convertPoint:event.locationInWindow fromView:nil];
        if (!target.isFlipped) point.y = target.bounds.size.height - point.y;
        napi_handle_scope scope;
        napi_open_handle_scope(env, &scope);
        napi_value value, fn, global, result, precise;
        napi_create_object(env, &value);
        number(env, value, "phase", event.phase);
        number(env, value, "momentumPhase", event.momentumPhase);
        number(env, value, "deltaX", -event.scrollingDeltaX);
        number(env, value, "deltaY", -event.scrollingDeltaY);
        number(env, value, "x", point.x);
        number(env, value, "y", point.y);
        number(env, value, "timestamp", event.timestamp * 1000);
        napi_get_boolean(env, event.hasPreciseScrollingDeltas, &precise);
        napi_set_named_property(env, value, "precise", precise);
        napi_get_reference_value(env, monitor->callback, &fn);
        napi_get_global(env, &global);
        napi_call_function(env, global, fn, 1, &value, &result);
        napi_close_handle_scope(env, scope);
        return event;
    }];
    if (!monitor->token) {
        stopMonitor(monitor);
        delete monitor;
        napi_throw_error(env, nullptr, "Could not install scroll monitor");
        return nullptr;
    }
    napi_value result;
    napi_create_function(env, "stop", NAPI_AUTO_LENGTH, stop, monitor, &result);
    napi_add_finalizer(env, result, monitor, finalize, nullptr, nullptr);
    return result;
}

static napi_value init(napi_env env, napi_value exports) {
    napi_property_descriptor descriptor = {"start", nullptr, start, nullptr, nullptr, nullptr, napi_default, nullptr};
    napi_define_properties(env, exports, 1, &descriptor);
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
