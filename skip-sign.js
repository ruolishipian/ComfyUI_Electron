// 强制跳过Windows代码签名的钩子脚本
exports.default = async function (context) {
  // 覆盖签名逻辑，直接返回空
  context.packager.sign = async () => {};
  context.packager.signApp = async () => {};
  console.log("✅ 已强制跳过Windows代码签名逻辑");
};