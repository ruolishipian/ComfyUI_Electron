// 强制跳过Windows代码签名的钩子脚本（适配你的electron-builder 24.13.3）
exports.default = async function (context) {
  // 覆盖签名相关函数，彻底阻止签名逻辑执行
  context.packager.sign = async () => {};
  context.packager.signApp = async () => {};
  console.log("✅ 已强制跳过Windows代码签名逻辑（适配ComfyUI_Electron）");
};