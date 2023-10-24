var __defProp = Object.defineProperty;
var __reflectGet = Reflect.get;
var __reflectSet = Reflect.set;
var __markAsModule = (target) =>
  __defProp(target, '__esModule', { value: true });
var __export = (target, all) => {
  __markAsModule(target);
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
__export(exports, {
  Foo: () => Foo,
});
class Foo {}
