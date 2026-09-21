export const GAMEPAD_PACKAGE_VERSION = "0.1.0";

export {
	bindingText,
	DEFAULT_BINDINGS,
	PAD_ACTION_KINDS,
	PAD_COMMAND_PREFIX,
	PAD_DIRECTIONS,
	PAD_INPUT_IDS,
	type PadActionKind,
	type PadBinding,
	type PadBindingMap,
	type PadDirection,
	type PadInputId,
	type ResolvedBindings,
	resolveBindings,
} from "./bindings.ts";

export {
	createPadBridge,
	type PadBridge,
	type PadBridgeOptions,
	type PadInstallation,
} from "./bridge.ts";

export {
	bluetoothCrcOk,
	crc32Le,
	DS4_BLUETOOTH_CRC_LENGTH,
	DS4_INPUT_CRC_SEED,
	DS4_OUTPUT_CRC_SEED,
	ds4BluetoothCrc,
} from "./crc32.ts";

export {
	buildDs4Output,
	DPAD_DIRECTIONS,
	type DpadDirection,
	DS4_BATTERY_FULL,
	DS4_BUTTON_IDS,
	DS4_PRODUCT_IDS,
	DS4_VENDOR_ID,
	type Ds4Axis,
	type Ds4Battery,
	type Ds4ButtonId,
	type Ds4OutputState,
	type Ds4Report,
	type Ds4State,
	type Ds4Touch,
	type Ds4TouchPoint,
	type Ds4Transport,
	decodeBattery,
	decodeTouch,
	describeModel,
	parseDs4Input,
	TOUCH_HEIGHT,
	TOUCH_WIDTH,
} from "./ds4.ts";

export {
	ANSI_RGB,
	createPadFeedback,
	PAD_BLINK_ATTENTION,
	PAD_BREATHE_MS,
	PAD_LOW_BATTERY_LEVEL,
	PAD_LOW_PULSE_MS,
	PAD_LOW_RGB,
	PAD_PULSE_MS,
	PAD_RUMBLE,
	PAD_RUMBLE_MIN_GAP_MS,
	PAD_WHITE,
	type PadBlink,
	type PadFeedback,
	type PadPalette,
	type PadRgb,
	type PadRumbleCommand,
	type PadRumbleEvent,
	type PadSignal,
	type PadUiPhase,
	padBatteryLow,
	padBlinkFor,
	padLightbarFor,
	padPalette,
	padRgb,
	padSignalEqual,
} from "./feedback.ts";

export {
	createMapper,
	DEFAULT_PAD_REPEAT,
	PAD_DEADZONE,
	PAD_HOLD_MS,
	PAD_MODIFIER_PRESS,
	PAD_STICK_BIAS,
	PAD_STICK_HYSTERESIS,
	type PadAction,
	type PadMapper,
	type PadMapperConfig,
	type PadPhase,
	type PadRepeat,
	stickDirection,
} from "./mapping.ts";

export {
	createPadService,
	noDeviceDetail,
	type PadClock,
	type PadSample,
	type PadService,
	type PadServiceConfig,
	type PadServiceDeps,
	type PadServicePhase,
	type PadServiceStatus,
	type PadStats,
	type PadTimer,
	type PadUiSignal,
	systemPadClock,
} from "./service.ts";

export {
	describePadDevice,
	deviceTransport,
	isDs4Device,
	matchesDevice,
	type PadSource,
	type PadSourceDevice,
	type PadSourceHandle,
	pickDevice,
	pickLinks,
} from "./source.ts";

export { createFauxSource, FAUX_DS4, type FauxSource } from "./sources/faux.ts";
export {
	createNodeHidSource,
	importNodeHid,
	NODE_HID_MISSING,
	type NodeHidDeviceInfo,
	type NodeHidHandle,
	type NodeHidLoader,
	type NodeHidModule,
	type NodeHidSourceOptions,
	nodeHidModuleFrom,
} from "./sources/node-hid.ts";
export {
	createTouchReader,
	isPadTouchId,
	PAD_TOUCH_IDS,
	type PadTouchConfig,
	type PadTouchId,
	type PadTouchReader,
	TOUCH_AXIS_BIAS,
	TOUCH_STEP,
	TOUCH_TAP_MS,
	TOUCH_TAP_SLOP,
} from "./touch.ts";
