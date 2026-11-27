#import <AppKit/AppKit.h>
#include <node_api.h>
@interface TestScroll : NSEvent
@property NSWindow *testWindow;
@end
@implementation TestScroll
- (NSEventType)type { return NSEventTypeScrollWheel; }
- (NSWindow *)window { return self.testWindow; }
- (NSInteger)windowNumber { return self.testWindow.windowNumber; }
- (NSPoint)locationInWindow { return NSMakePoint(30, 40); }
- (NSEventPhase)phase { return NSEventPhaseBegan; }
- (NSEventPhase)momentumPhase { return NSEventPhaseNone; }
- (CGFloat)scrollingDeltaX { return 5; }
- (CGFloat)scrollingDeltaY { return -2; }
- (BOOL)hasPreciseScrollingDeltas { return YES; }
- (NSTimeInterval)timestamp { return 10; }
@end
static napi_value emit(napi_env env,napi_callback_info info) {
 size_t n=1, length=0; napi_value args[1]; void *bytes;
 napi_get_cb_info(env,info,&n,args,nullptr,nullptr); napi_get_buffer_info(env,args[0],&bytes,&length);
 NSView *view=(__bridge NSView *)*(void **)bytes; TestScroll *e=[TestScroll new]; e.testWindow=view.window;
 [NSApp sendEvent:e]; return nullptr;
}
static napi_value init(napi_env env,napi_value out) { napi_property_descriptor d={"emit",nullptr,emit,nullptr,nullptr,nullptr,napi_default,nullptr}; napi_define_properties(env,out,1,&d); return out; }
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
