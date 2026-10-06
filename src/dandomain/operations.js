// src/dandomain/operations.js — PINNED DanDomain (Hostedshop) SOAP operation surface.
//
// !!! GENERATED FILE — DO NOT EDIT BY HAND. !!!
// Regenerate with:  node scripts/gen-operations.mjs
// Source WSDL:      data/probes/service.wsdl
// WSDL sha256:      6d8e7ced97d16625c9c7ae21e71ce7665bd9c0a91f2a622ce1522e8faa9adeae
// WSDL bytes:       439500
// Generator:        scripts/gen-operations.mjs
// No timestamp is emitted on purpose: the same WSDL must produce a byte-identical file,
// so any diff here is a real API change (or a hand edit, which is a bug).
//
// WHY THIS FILE EXISTS
//
// R17/R27 — Unknown ARGUMENT names are silently dropped by the server. They do not fault
//   as NOSUCHPARAM; the call arrives with fewer arguments and PHP answers
//   "Too few arguments to function WebService::X(), 0 passed ... exactly 2 expected".
//   That is a NAME error, not a transient, and it has already broken three operations
//   that were called with hand-guessed argument names. OPERATIONS[op].args is the
//   transcribed truth: names, order, xsd type and nillable. validateArgs() is the
//   pre-flight check.
//
//   WHAT "required" IS NOT. Every one of the 298 arguments in this WSDL omits
//   minOccurs, so `required` is true for all of them and carries NO information about
//   what the PHP implementation will accept. The WSDL's only per-argument optionality
//   signal is nillable="true" (22 arguments across 12 operations), and the
//   live probe settled one of them: data/probes/gaps.json sections.orderGetByDate records
//   Order_GetByDate called with Start+End and NO Status element at all —
//   {"label":"Status omitted","ok":true,"count":20}, plus "statusIsOptionalInPractice":true
//   and "omittingStatusReturnsEverything":true. So validateArgs() splits the two: an absent
//   NON-nillable argument goes in missingRequired[] and fails .ok; an absent NILLABLE one
//   goes in missingNillable[] as an advisory and does NOT fail .ok. Gating on .ok with the
//   old rule made the date-window order read impossible without inventing a Status — and
//   the same probe shows Status:"0" returns 19 of 20 orders (order 17, status 99, is
//   silently lost). Only Order_GetByDate/Status was probed; the other 21 nillable
//   arguments are treated the same way by inference from the WSDL, not from a live call.
//
// R4 — One invalid field name faults the whole *_SetFields call AND the session silently
//   keeps the PREVIOUS field set, so the next read succeeds with the wrong shape and no
//   error. TYPES maps every complexType to its exact field list so a field list can be
//   validated with validateFields() BEFORE it is sent. NOSUCHPARAM is fatal; never retry.
//
// F1 — ENDPOINT is read from the WSDL's <soap:address location=...>. It is never
//   hardcoded, and the WSDL uses the DEFAULT namespace (<definitions>, <operation>),
//   which is why the generator resolves namespace URIs instead of matching "wsdl:"
//   prefixes. This WSDL declares 247 operations — counted in <portType> and
//   cross-checked against <binding>, which the generator requires to agree name for
//   name. The doc app's 249 is wrong (F1); this number is not typed in anywhere, it
//   is whatever the WSDL says.
//
// This module is pure data plus pure functions: no I/O, no network, no stdout, and it
// throws rather than guessing when asked about something the WSDL does not define —
// a helper that returned [] for an unknown operation would reintroduce exactly the
// silent-drop failure (R27) this file was written to stop.

export const SOURCE = {
  "wsdl": "data/probes/service.wsdl",
  "sha256": "6d8e7ced97d16625c9c7ae21e71ce7665bd9c0a91f2a622ce1522e8faa9adeae",
  "bytes": 439500,
  "generator": "scripts/gen-operations.mjs",
  "targetNamespace": "https://api.hostedshop.io/service.php",
  "style": "document",
  "transport": "http://schemas.xmlsoap.org/soap/http"
};

// F1: the endpoint, exactly as the WSDL advertises it. Do not hardcode this elsewhere.
export const ENDPOINT = "https://api.hostedshop.io/service.php";

export const OPERATION_COUNT = 247;
export const TYPE_COUNT = 178;

// R4: the only operations that change a session's field set — ALL 6 of them. Every one
// takes a single comma-separated "Fields" string, and one bad name in it faults the call
// while the session keeps its PREVIOUS field set. Selected by ARGUMENT SHAPE (one argument
// named Fields of type xsd:string), not by the "_SetFields" name suffix: the suffix misses
// Order_SetOrderLineFields and Product_SetVariantFields, both of which the live probe called
// (probe-dandomain.mjs:880/943, :1634; gaps.json sections.variants.setVariantFieldsOk).
// R4 says the client MUST re-assert EVERY field set after any fault or reconnect, so a short
// list means the OrderLine and ProductVariant formats silently fall back to Id-only after an
// AUTH replay and the next read returns a smaller record with no error.
export const FIELD_SET_OPERATIONS = ["User_SetFields", "Order_SetFields", "Order_SetOrderLineFields", "Product_SetFields", "Product_SetVariantFields", "PageText_SetFields"];

// R4: which complexType each field set is validated against. Read from the WSDL's own
// <documentation> for the operation ("Sets the outputformat for all methods returning
// ProductVariant Objects"), NOT inferred from the operation name — that is how
// Product_SetVariantFields resolves to ProductVariant rather than Product. The generator
// fails the build if a documentation string stops naming a type, or names one that is not a
// complexType here, so this cannot rot into a wrong-but-plausible mapping. Use it to pick the
// argument for validateFields(): every one of the 178 complexTypes is a legal argument to
// that function, including the *Create/*Update inputs and the ArrayOf* wrappers, so a guessed
// type name is green-lit silently.
export const SET_FIELDS_TYPE = {
  "User_SetFields": "User",
  "Order_SetFields": "Order",
  "Order_SetOrderLineFields": "OrderLine",
  "Product_SetFields": "Product",
  "Product_SetVariantFields": "ProductVariant",
  "PageText_SetFields": "PageText"
};

// F2 — the ONE thing in this file that is not transcribed from the WSDL, and it is here
// precisely because the WSDL advertises the call as if it were safe. Solution_SetEncoding
// must NEVER be called: the API is UTF-8-native, so asking it for UTF-8 makes it convert
// twice — it mojibakes reads and IRREVERSIBLY destroys writes ("Æblegrød" -> "?r? ??? ???").
// The design doc says to call it; the design doc is wrong. The generator verifies each
// name below still exists in the WSDL, so this list cannot rot into a no-op.
export const FORBIDDEN_OPERATIONS = ["Solution_SetEncoding"];


// Every operation the WSDL declares, in WSDL document order.
//   args             — argument names IN ORDER, with xsd type, nillable and required
//                      (required === minOccurs is absent or > 0). The order is the
//                      WSDL's own: every request wrapper that takes arguments is an
//                      <xsd:sequence>, so the order is part of the schema. A name that is
//                      not in this list is dropped in flight and comes back as an arity
//                      error (R17/R27).
//   responseElement  — name of the response wrapper element
//   resultElement    — name of the single child holding the result (null for void)
//   resultType       — xsd builtin ("xsd:boolean") or schema type ("tns:ArrayOfOrder")
//   resultItemType   — for array results, the type of the repeated child (structurally
//                      detected from the wrapper's particle, not from its name)
export const OPERATIONS = {
  "Solution_Connect": {
    "soapAction": "https://api.hostedshop.io/service.php#Solution_Connect",
    "requestElement": "Solution_Connect",
    "args": [
      { "name": "Username", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Password", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Solution_ConnectResponse",
    "resultElement": "Solution_ConnectResult",
    "resultType": "xsd:boolean",
    "documentation": "Connects to a Solution"
  },
  "Solution_GetWebinfo": {
    "soapAction": "https://api.hostedshop.io/service.php#Solution_GetWebinfo",
    "requestElement": "Solution_GetWebinfo",
    "args": [],
    "responseElement": "Solution_GetWebinfoResponse",
    "resultElement": "Solution_GetWebinfoResult",
    "resultType": "tns:ShopWebinfo",
    "documentation": "Returns the web information for the solution"
  },
  "Solution_SetEncoding": {
    "soapAction": "https://api.hostedshop.io/service.php#Solution_SetEncoding",
    "requestElement": "Solution_SetEncoding",
    "args": [
      { "name": "Encoding", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Solution_SetEncodingResponse",
    "resultElement": "Solution_SetEncodingResult",
    "resultType": "xsd:boolean",
    "documentation": "Sets the encoding of all outgoing textfields, and the expected encoding of all incomming fields"
  },
  "Solution_CreateThumb": {
    "soapAction": "https://api.hostedshop.io/service.php#Solution_CreateThumb",
    "requestElement": "Solution_CreateThumb",
    "args": [
      { "name": "ImagePath", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ThumbWidth", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ThumbHeight", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Crop", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Greyscale", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Watermark", "type": "xsd:boolean", "nillable": false, "required": true }
    ],
    "responseElement": "Solution_CreateThumbResponse",
    "resultElement": "Solution_CreateThumbResult",
    "resultType": "xsd:string",
    "documentation": "Creates a thumbnail of an image and returns its path (if the thumbnail already exists the path is returned without other actions)"
  },
  "Solution_CreateThumbs": {
    "soapAction": "https://api.hostedshop.io/service.php#Solution_CreateThumbs",
    "requestElement": "Solution_CreateThumbs",
    "args": [
      { "name": "ImagePaths", "type": "tns:ArrayOfString", "nillable": false, "required": true },
      { "name": "ThumbWidth", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ThumbHeight", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Crop", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Greyscale", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Watermark", "type": "xsd:boolean", "nillable": false, "required": true }
    ],
    "responseElement": "Solution_CreateThumbsResponse",
    "resultElement": "Solution_CreateThumbsResult",
    "resultType": "tns:ArrayOfString",
    "resultItemType": "xsd:string",
    "resultItemElement": "item",
    "documentation": "Creates thumbnails of images and returns their paths (if the thumbnail already exists the path is returned without other actions)"
  },
  "Solution_GetLanguages": {
    "soapAction": "https://api.hostedshop.io/service.php#Solution_GetLanguages",
    "requestElement": "Solution_GetLanguages",
    "args": [],
    "responseElement": "Solution_GetLanguagesResponse",
    "resultElement": "Solution_GetLanguagesResult",
    "resultType": "tns:ArrayOfSolutionlanguage",
    "resultItemType": "tns:SolutionLanguage",
    "resultItemElement": "item",
    "documentation": "Returns the utilized languages of this system"
  },
  "Solution_SetLanguage": {
    "soapAction": "https://api.hostedshop.io/service.php#Solution_SetLanguage",
    "requestElement": "Solution_SetLanguage",
    "args": [
      { "name": "LanguageISO", "type": "xsd:string", "nillable": true, "required": true }
    ],
    "responseElement": "Solution_SetLanguageResponse",
    "resultElement": "Solution_SetLanguageResult",
    "resultType": "xsd:boolean",
    "documentation": "Sets the SolutionLanguage of this shop instance. This affects all Objects with language specific text"
  },
  "Solution_SetCaseSensitiveItemNumber": {
    "soapAction": "https://api.hostedshop.io/service.php#Solution_SetCaseSensitiveItemNumber",
    "requestElement": "Solution_SetCaseSensitiveItemNumber",
    "args": [
      { "name": "Enabled", "type": "xsd:boolean", "nillable": false, "required": true }
    ],
    "responseElement": "Solution_SetCaseSensitiveItemNumberResponse",
    "resultElement": "Solution_SetCaseSensitiveItemNumberResult",
    "resultType": "xsd:boolean",
    "documentation": "Enables or disables case sensitive matching of ItemNumbers for alle methods using these as keys. Default is non-case-sensitive mode"
  },
  "Solution_HasModule": {
    "soapAction": "https://api.hostedshop.io/service.php#Solution_HasModule",
    "requestElement": "Solution_HasModule",
    "args": [
      { "name": "module", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Solution_HasModuleResponse",
    "resultElement": "Solution_HasModuleResult",
    "resultType": "xsd:boolean",
    "documentation": "Checks whether or not the solution has the module"
  },
  "User_SetFields": {
    "soapAction": "https://api.hostedshop.io/service.php#User_SetFields",
    "requestElement": "User_SetFields",
    "args": [
      { "name": "Fields", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "User_SetFieldsResponse",
    "resultElement": "User_SetFieldsResult",
    "resultType": "xsd:boolean",
    "documentation": "Sets the outputformat for all methods returning User Objects. If not set, the output format includes only the Id"
  },
  "User_GetAll": {
    "soapAction": "https://api.hostedshop.io/service.php#User_GetAll",
    "requestElement": "User_GetAll",
    "args": [],
    "responseElement": "User_GetAllResponse",
    "resultElement": "User_GetAllResult",
    "resultType": "tns:ArrayOfUser",
    "resultItemType": "tns:User",
    "resultItemElement": "item",
    "documentation": "Returns all Users. The output format can be set with User_SetFields"
  },
  "User_GetAllByDate": {
    "soapAction": "https://api.hostedshop.io/service.php#User_GetAllByDate",
    "requestElement": "User_GetAllByDate",
    "args": [
      { "name": "Start", "type": "xsd:string", "nillable": true, "required": true },
      { "name": "End", "type": "xsd:string", "nillable": true, "required": true }
    ],
    "responseElement": "User_GetAllByDateResponse",
    "resultElement": "User_GetAllByDateResult",
    "resultType": "tns:ArrayOfUser",
    "resultItemType": "tns:User",
    "resultItemElement": "item",
    "documentation": "Returns all Users created or updated in a given timespan. The output format can be set with User_SetFields"
  },
  "User_GetAllNewsletterByDate": {
    "soapAction": "https://api.hostedshop.io/service.php#User_GetAllNewsletterByDate",
    "requestElement": "User_GetAllNewsletterByDate",
    "args": [
      { "name": "Start", "type": "xsd:string", "nillable": true, "required": true },
      { "name": "End", "type": "xsd:string", "nillable": true, "required": true }
    ],
    "responseElement": "User_GetAllNewsletterByDateResponse",
    "resultElement": "User_GetAllNewsletterByDateResult",
    "resultType": "tns:ArrayOfUser",
    "resultItemType": "tns:User",
    "resultItemElement": "item",
    "documentation": "Returns all Newsletter Users created or updated in a given timespan. The output format can be set with User_SetFields"
  },
  "User_GetById": {
    "soapAction": "https://api.hostedshop.io/service.php#User_GetById",
    "requestElement": "User_GetById",
    "args": [
      { "name": "UserId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "User_GetByIdResponse",
    "resultElement": "User_GetByIdResult",
    "resultType": "tns:User",
    "documentation": "Returns the indicated User. The output format can be set with User_SetFields"
  },
  "User_GetByName": {
    "soapAction": "https://api.hostedshop.io/service.php#User_GetByName",
    "requestElement": "User_GetByName",
    "args": [
      { "name": "UserName", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "User_GetByNameResponse",
    "resultElement": "User_GetByNameResult",
    "resultType": "tns:ArrayOfUser",
    "resultItemType": "tns:User",
    "resultItemElement": "item",
    "documentation": "Returns users with a full or partial match of the supplied name. The output format can be set with User_SetFields"
  },
  "User_GetByGroup": {
    "soapAction": "https://api.hostedshop.io/service.php#User_GetByGroup",
    "requestElement": "User_GetByGroup",
    "args": [
      { "name": "UserGroupId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "User_GetByGroupResponse",
    "resultElement": "User_GetByGroupResult",
    "resultType": "tns:ArrayOfUser",
    "resultItemType": "tns:User",
    "resultItemElement": "item",
    "documentation": "Returns Users of the incidated UserGroup. The output format can be set with User_SetFields"
  },
  "User_GetAllNewsletter": {
    "soapAction": "https://api.hostedshop.io/service.php#User_GetAllNewsletter",
    "requestElement": "User_GetAllNewsletter",
    "args": [],
    "responseElement": "User_GetAllNewsletterResponse",
    "resultElement": "User_GetAllNewsletterResult",
    "resultType": "tns:ArrayOfUser",
    "resultItemType": "tns:User",
    "resultItemElement": "item",
    "documentation": "Returns all Users. The output format can be set with User_SetFields"
  },
  "User_Create": {
    "soapAction": "https://api.hostedshop.io/service.php#User_Create",
    "requestElement": "User_Create",
    "args": [
      { "name": "UserData", "type": "tns:UserCreate", "nillable": false, "required": true }
    ],
    "responseElement": "User_CreateResponse",
    "resultElement": "User_CreateResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new User"
  },
  "User_Update": {
    "soapAction": "https://api.hostedshop.io/service.php#User_Update",
    "requestElement": "User_Update",
    "args": [
      { "name": "UserData", "type": "tns:UserUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "User_UpdateResponse",
    "resultElement": "User_UpdateResult",
    "resultType": "xsd:int",
    "documentation": "Updates a User"
  },
  "User_CreateOrUpdate": {
    "soapAction": "https://api.hostedshop.io/service.php#User_CreateOrUpdate",
    "requestElement": "User_CreateOrUpdate",
    "args": [
      { "name": "UserData", "type": "tns:UserCreateUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "User_CreateOrUpdateResponse",
    "resultElement": "User_CreateOrUpdateResult",
    "resultType": "xsd:int",
    "documentation": "Creates or Updates a User using Username as key. Assumes that only unique Usernames exist in the shop. If the Username supplied is not found a new User is created"
  },
  "User_Delete": {
    "soapAction": "https://api.hostedshop.io/service.php#User_Delete",
    "requestElement": "User_Delete",
    "args": [
      { "name": "UserId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "User_DeleteResponse",
    "resultElement": "User_DeleteResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a User"
  },
  "User_GetGroupAll": {
    "soapAction": "https://api.hostedshop.io/service.php#User_GetGroupAll",
    "requestElement": "User_GetGroupAll",
    "args": [],
    "responseElement": "User_GetGroupAllResponse",
    "resultElement": "User_GetGroupAllResult",
    "resultType": "tns:ArrayOfUsergroup",
    "resultItemType": "tns:UserGroup",
    "resultItemElement": "item",
    "documentation": "Returns all UserGroups of the solution"
  },
  "User_GetGroupById": {
    "soapAction": "https://api.hostedshop.io/service.php#User_GetGroupById",
    "requestElement": "User_GetGroupById",
    "args": [
      { "name": "UserGroupId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "User_GetGroupByIdResponse",
    "resultElement": "User_GetGroupByIdResult",
    "resultType": "tns:UserGroup",
    "documentation": "Returns the indicated UserGroup"
  },
  "User_CreateGroup": {
    "soapAction": "https://api.hostedshop.io/service.php#User_CreateGroup",
    "requestElement": "User_CreateGroup",
    "args": [
      { "name": "UserGroupData", "type": "tns:UserGroupCreate", "nillable": false, "required": true }
    ],
    "responseElement": "User_CreateGroupResponse",
    "resultElement": "User_CreateGroupResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new UserGroup"
  },
  "User_UpdateGroup": {
    "soapAction": "https://api.hostedshop.io/service.php#User_UpdateGroup",
    "requestElement": "User_UpdateGroup",
    "args": [
      { "name": "UserGroupData", "type": "tns:UserGroupUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "User_UpdateGroupResponse",
    "resultElement": "User_UpdateGroupResult",
    "resultType": "xsd:int",
    "documentation": "Updates a UserGroup"
  },
  "User_DeleteGroup": {
    "soapAction": "https://api.hostedshop.io/service.php#User_DeleteGroup",
    "requestElement": "User_DeleteGroup",
    "args": [
      { "name": "UserGroupId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "User_DeleteGroupResponse",
    "resultElement": "User_DeleteGroupResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a UserGroup"
  },
  "Newsletter_GetCustomFieldById": {
    "soapAction": "https://api.hostedshop.io/service.php#Newsletter_GetCustomFieldById",
    "requestElement": "Newsletter_GetCustomFieldById",
    "args": [
      { "name": "CustomFieldId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Newsletter_GetCustomFieldByIdResponse",
    "resultElement": "Newsletter_GetCustomFieldByIdResult",
    "resultType": "tns:NewsletterCustomField",
    "documentation": "Returns the indicated NewsletterCustomField"
  },
  "Newsletter_GetCustomFieldByGroup": {
    "soapAction": "https://api.hostedshop.io/service.php#Newsletter_GetCustomFieldByGroup",
    "requestElement": "Newsletter_GetCustomFieldByGroup",
    "args": [
      { "name": "UserGroupId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ServiceId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Newsletter_GetCustomFieldByGroupResponse",
    "resultElement": "Newsletter_GetCustomFieldByGroupResult",
    "resultType": "tns:ArrayOfNewslettercustomfield",
    "resultItemType": "tns:NewsletterCustomField",
    "resultItemElement": "item",
    "documentation": "Returns the NewsletterCustomFields of the indicated UserGroup and Type (1: Mailmarketing)"
  },
  "Newsletter_DeleteCustomField": {
    "soapAction": "https://api.hostedshop.io/service.php#Newsletter_DeleteCustomField",
    "requestElement": "Newsletter_DeleteCustomField",
    "args": [
      { "name": "CustomFieldId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Newsletter_DeleteCustomFieldResponse",
    "resultElement": "Newsletter_DeleteCustomFieldResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a NewsletterCustomField"
  },
  "Category_GetById": {
    "soapAction": "https://api.hostedshop.io/service.php#Category_GetById",
    "requestElement": "Category_GetById",
    "args": [
      { "name": "CategoryId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Category_GetByIdResponse",
    "resultElement": "Category_GetByIdResult",
    "resultType": "tns:Category",
    "documentation": "Returns the indicated Category"
  },
  "Category_GetAll": {
    "soapAction": "https://api.hostedshop.io/service.php#Category_GetAll",
    "requestElement": "Category_GetAll",
    "args": [],
    "responseElement": "Category_GetAllResponse",
    "resultElement": "Category_GetAllResult",
    "resultType": "tns:ArrayOfCategory",
    "resultItemType": "tns:Category",
    "resultItemElement": "item",
    "documentation": "Returns all Categories"
  },
  "Category_UpdateTitle": {
    "soapAction": "https://api.hostedshop.io/service.php#Category_UpdateTitle",
    "requestElement": "Category_UpdateTitle",
    "args": [
      { "name": "CategoryId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Category_UpdateTitleResponse",
    "resultElement": "Category_UpdateTitleResult",
    "resultType": "xsd:boolean",
    "documentation": "Updates the Title of a Category in the specified Language"
  },
  "Category_Create": {
    "soapAction": "https://api.hostedshop.io/service.php#Category_Create",
    "requestElement": "Category_Create",
    "args": [
      { "name": "CategoryData", "type": "tns:CategoryCreate", "nillable": false, "required": true }
    ],
    "responseElement": "Category_CreateResponse",
    "resultElement": "Category_CreateResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new Category"
  },
  "Category_Update": {
    "soapAction": "https://api.hostedshop.io/service.php#Category_Update",
    "requestElement": "Category_Update",
    "args": [
      { "name": "CategoryData", "type": "tns:CategoryUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Category_UpdateResponse",
    "resultElement": "Category_UpdateResult",
    "resultType": "xsd:int",
    "documentation": "Updates a new Category"
  },
  "Category_CreateOrUpdate": {
    "soapAction": "https://api.hostedshop.io/service.php#Category_CreateOrUpdate",
    "requestElement": "Category_CreateOrUpdate",
    "args": [
      { "name": "CategoryData", "type": "tns:CategoryCreateUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Category_CreateOrUpdateResponse",
    "resultElement": "Category_CreateOrUpdateResult",
    "resultType": "xsd:int",
    "documentation": "Creates or updates a Category. Assumes that only unique Category titles exist for a given level in the shop. If the Title supplied is not found a new User is created"
  },
  "Category_Delete": {
    "soapAction": "https://api.hostedshop.io/service.php#Category_Delete",
    "requestElement": "Category_Delete",
    "args": [
      { "name": "CategoryId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Category_DeleteResponse",
    "resultElement": "Category_DeleteResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a Category"
  },
  "Category_GetPictures": {
    "soapAction": "https://api.hostedshop.io/service.php#Category_GetPictures",
    "requestElement": "Category_GetPictures",
    "args": [
      { "name": "CategoryId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Category_GetPicturesResponse",
    "resultElement": "Category_GetPicturesResult",
    "resultType": "tns:ArrayOfCategorypicture",
    "resultItemType": "tns:CategoryPicture",
    "resultItemElement": "item",
    "documentation": "Returns the CategoryPictures of the indicated Category"
  },
  "Category_CreatePicture": {
    "soapAction": "https://api.hostedshop.io/service.php#Category_CreatePicture",
    "requestElement": "Category_CreatePicture",
    "args": [
      { "name": "CategoryPictureData", "type": "tns:CategoryPictureCreate", "nillable": false, "required": true }
    ],
    "responseElement": "Category_CreatePictureResponse",
    "resultElement": "Category_CreatePictureResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new CategoryPicture"
  },
  "Category_UpdatePicture": {
    "soapAction": "https://api.hostedshop.io/service.php#Category_UpdatePicture",
    "requestElement": "Category_UpdatePicture",
    "args": [
      { "name": "CategoryPictureData", "type": "tns:CategoryPictureUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Category_UpdatePictureResponse",
    "resultElement": "Category_UpdatePictureResult",
    "resultType": "xsd:int",
    "documentation": "Updates a CategoryPicture"
  },
  "Category_DeletePicture": {
    "soapAction": "https://api.hostedshop.io/service.php#Category_DeletePicture",
    "requestElement": "Category_DeletePicture",
    "args": [
      { "name": "CategoryPictureId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Category_DeletePictureResponse",
    "resultElement": "Category_DeletePictureResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a CategoryPicture"
  },
  "Product_GetDiscounts": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetDiscounts",
    "requestElement": "Product_GetDiscounts",
    "args": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetDiscountsResponse",
    "resultElement": "Product_GetDiscountsResult",
    "resultType": "tns:ArrayOfProductdiscount",
    "resultItemType": "tns:ProductDiscount",
    "resultItemElement": "item",
    "documentation": "Returns the ProductDiscounts of a product"
  },
  "Product_GetDiscount": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetDiscount",
    "requestElement": "Product_GetDiscount",
    "args": [
      { "name": "DiscountId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetDiscountResponse",
    "resultElement": "Product_GetDiscountResult",
    "resultType": "tns:ProductDiscount",
    "documentation": "Returns a ProductDiscount"
  },
  "Product_CreateDiscount": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_CreateDiscount",
    "requestElement": "Product_CreateDiscount",
    "args": [
      { "name": "ProductDiscountData", "type": "tns:ProductDiscountCreate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_CreateDiscountResponse",
    "resultElement": "Product_CreateDiscountResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new ProductDiscount"
  },
  "Product_UpdateDiscount": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_UpdateDiscount",
    "requestElement": "Product_UpdateDiscount",
    "args": [
      { "name": "ProductDiscountData", "type": "tns:ProductDiscountUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_UpdateDiscountResponse",
    "resultElement": "Product_UpdateDiscountResult",
    "resultType": "xsd:int",
    "documentation": "Updates a ProductDiscount"
  },
  "Product_DeleteDiscount": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_DeleteDiscount",
    "requestElement": "Product_DeleteDiscount",
    "args": [
      { "name": "ProductDiscountId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_DeleteDiscountResponse",
    "resultElement": "Product_DeleteDiscountResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a ProductDiscount"
  },
  "Product_DeleteAdditional": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_DeleteAdditional",
    "requestElement": "Product_DeleteAdditional",
    "args": [
      { "name": "ProductAdditionalId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_DeleteAdditionalResponse",
    "resultElement": "Product_DeleteAdditionalResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a ProductAdditional"
  },
  "Product_DeleteAllDiscounts": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_DeleteAllDiscounts",
    "requestElement": "Product_DeleteAllDiscounts",
    "args": [
      { "name": "ProductItemNumber", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Product_DeleteAllDiscountsResponse",
    "resultElement": "Product_DeleteAllDiscountsResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes all ProductDiscounts of a Product"
  },
  "Product_GetDiscountAccumulative": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetDiscountAccumulative",
    "requestElement": "Product_GetDiscountAccumulative",
    "args": [
      { "name": "DiscountId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetDiscountAccumulativeResponse",
    "resultElement": "Product_GetDiscountAccumulativeResult",
    "resultType": "tns:ProductDiscountAccumulative",
    "documentation": "Returns a ProductDiscountAccumulative"
  },
  "Product_GetDiscountsAccumulative": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetDiscountsAccumulative",
    "requestElement": "Product_GetDiscountsAccumulative",
    "args": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetDiscountsAccumulativeResponse",
    "resultElement": "Product_GetDiscountsAccumulativeResult",
    "resultType": "tns:ArrayOfProductdiscountaccumulative",
    "resultItemType": "tns:ProductDiscountAccumulative",
    "resultItemElement": "item",
    "documentation": "Returns the ProductDiscountAccumulatives of a Product"
  },
  "Product_GetDiscountsAccumulativeAll": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetDiscountsAccumulativeAll",
    "requestElement": "Product_GetDiscountsAccumulativeAll",
    "args": [],
    "responseElement": "Product_GetDiscountsAccumulativeAllResponse",
    "resultElement": "Product_GetDiscountsAccumulativeAllResult",
    "resultType": "tns:ArrayOfProductdiscountaccumulative",
    "resultItemType": "tns:ProductDiscountAccumulative",
    "resultItemElement": "item",
    "documentation": "Returns all ProductDiscountAccumulatives"
  },
  "Product_GetDiscountsAccumulativeAllWithPagination": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetDiscountsAccumulativeAllWithPagination",
    "requestElement": "Product_GetDiscountsAccumulativeAllWithPagination",
    "args": [
      { "name": "Page", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "PageSize", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetDiscountsAccumulativeAllWithPaginationResponse",
    "resultElement": "Product_GetDiscountsAccumulativeAllWithPaginationResult",
    "resultType": "tns:ArrayOfProductdiscountaccumulative",
    "resultItemType": "tns:ProductDiscountAccumulative",
    "resultItemElement": "item",
    "documentation": "Retrieve all ProductDiscountAccumulatives one page at a time"
  },
  "Product_GetDiscountsAccumulativeByUser": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetDiscountsAccumulativeByUser",
    "requestElement": "Product_GetDiscountsAccumulativeByUser",
    "args": [
      { "name": "UserId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetDiscountsAccumulativeByUserResponse",
    "resultElement": "Product_GetDiscountsAccumulativeByUserResult",
    "resultType": "tns:ArrayOfProductdiscountaccumulative",
    "resultItemType": "tns:ProductDiscountAccumulative",
    "resultItemElement": "item",
    "documentation": "Returns the ProductDiscountAccumulatives of a User"
  },
  "Product_GetDiscountsAccumulativeByUserGroup": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetDiscountsAccumulativeByUserGroup",
    "requestElement": "Product_GetDiscountsAccumulativeByUserGroup",
    "args": [
      { "name": "UserDiscountGroupId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetDiscountsAccumulativeByUserGroupResponse",
    "resultElement": "Product_GetDiscountsAccumulativeByUserGroupResult",
    "resultType": "tns:ArrayOfProductdiscountaccumulative",
    "resultItemType": "tns:ProductDiscountAccumulative",
    "resultItemElement": "item",
    "documentation": "Returns the ProductDiscountAccumulatives of a UserDiscountGroup"
  },
  "Product_GetDiscountsAccumulativeByProductGroup": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetDiscountsAccumulativeByProductGroup",
    "requestElement": "Product_GetDiscountsAccumulativeByProductGroup",
    "args": [
      { "name": "DiscountGroupProductId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetDiscountsAccumulativeByProductGroupResponse",
    "resultElement": "Product_GetDiscountsAccumulativeByProductGroupResult",
    "resultType": "tns:ArrayOfProductdiscountaccumulative",
    "resultItemType": "tns:ProductDiscountAccumulative",
    "resultItemElement": "item",
    "documentation": "Returns the ProductDiscountAccumulatives of a DiscountGroupProduct"
  },
  "Product_UpdateDiscountAccumulative": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_UpdateDiscountAccumulative",
    "requestElement": "Product_UpdateDiscountAccumulative",
    "args": [
      { "name": "ProductDiscountAccumulativeData", "type": "tns:ProductDiscountAccumulativeUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_UpdateDiscountAccumulativeResponse",
    "resultElement": "Product_UpdateDiscountAccumulativeResult",
    "resultType": "xsd:int",
    "documentation": "Updates a ProductDiscountAccumulative"
  },
  "Product_CreateDiscountAccumulative": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_CreateDiscountAccumulative",
    "requestElement": "Product_CreateDiscountAccumulative",
    "args": [
      { "name": "ProductDiscountAccumulativeData", "type": "tns:ProductDiscountAccumulativeCreate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_CreateDiscountAccumulativeResponse",
    "resultElement": "Product_CreateDiscountAccumulativeResult",
    "resultType": "xsd:int",
    "documentation": "Creates a ProductDiscountAccumulative"
  },
  "Product_DeleteDiscountAccumulative": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_DeleteDiscountAccumulative",
    "requestElement": "Product_DeleteDiscountAccumulative",
    "args": [
      { "name": "ProductDiscountAccumulativeId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_DeleteDiscountAccumulativeResponse",
    "resultElement": "Product_DeleteDiscountAccumulativeResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a ProductDiscountAccumulative"
  },
  "Product_DeleteAllDiscountAccumulatives": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_DeleteAllDiscountAccumulatives",
    "requestElement": "Product_DeleteAllDiscountAccumulatives",
    "args": [
      { "name": "ProductItemNumber", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Product_DeleteAllDiscountAccumulativesResponse",
    "resultElement": "Product_DeleteAllDiscountAccumulativesResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes all ProductDiscountAccumulatives of a Product"
  },
  "Product_DeleteAllDiscountAccumulativeByProductGroup": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_DeleteAllDiscountAccumulativeByProductGroup",
    "requestElement": "Product_DeleteAllDiscountAccumulativeByProductGroup",
    "args": [
      { "name": "DiscountGroupProductTitle", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Product_DeleteAllDiscountAccumulativeByProductGroupResponse",
    "resultElement": "Product_DeleteAllDiscountAccumulativeByProductGroupResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes all ProductDiscountAccumulatives of a DiscountGroupProduct"
  },
  "Product_GetUnitById": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetUnitById",
    "requestElement": "Product_GetUnitById",
    "args": [
      { "name": "ProductUnitId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetUnitByIdResponse",
    "resultElement": "Product_GetUnitByIdResult",
    "resultType": "tns:ProductUnit",
    "documentation": "Returns the indicated ProductUnit."
  },
  "Product_GetUnitAll": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetUnitAll",
    "requestElement": "Product_GetUnitAll",
    "args": [],
    "responseElement": "Product_GetUnitAllResponse",
    "resultElement": "Product_GetUnitAllResult",
    "resultType": "tns:ArrayOfProductunit",
    "resultItemType": "tns:ProductUnit",
    "resultItemElement": "item",
    "documentation": "Returns all ProductUnits."
  },
  "Product_CreateUnit": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_CreateUnit",
    "requestElement": "Product_CreateUnit",
    "args": [
      { "name": "ProductUnitData", "type": "tns:ProductUnitCreate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_CreateUnitResponse",
    "resultElement": "Product_CreateUnitResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new ProductUnit"
  },
  "Product_UpdateUnit": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_UpdateUnit",
    "requestElement": "Product_UpdateUnit",
    "args": [
      { "name": "ProductUnitData", "type": "tns:ProductUnitUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_UpdateUnitResponse",
    "resultElement": "Product_UpdateUnitResult",
    "resultType": "xsd:int",
    "documentation": "Updates a ProductUnit"
  },
  "Product_DeleteUnit": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_DeleteUnit",
    "requestElement": "Product_DeleteUnit",
    "args": [
      { "name": "ProductUnitId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_DeleteUnitResponse",
    "resultElement": "Product_DeleteUnitResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a ProductUnit"
  },
  "Currency_GetAll": {
    "soapAction": "https://api.hostedshop.io/service.php#Currency_GetAll",
    "requestElement": "Currency_GetAll",
    "args": [],
    "responseElement": "Currency_GetAllResponse",
    "resultElement": "Currency_GetAllResult",
    "resultType": "tns:ArrayOfCurrency",
    "resultItemType": "tns:Currency",
    "resultItemElement": "item",
    "documentation": "Returns all Currencies"
  },
  "Currency_GetByIso": {
    "soapAction": "https://api.hostedshop.io/service.php#Currency_GetByIso",
    "requestElement": "Currency_GetByIso",
    "args": [
      { "name": "Iso", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Currency_GetByIsoResponse",
    "resultElement": "Currency_GetByIsoResult",
    "resultType": "tns:Currency",
    "documentation": "Returns the indicated Currency"
  },
  "Currency_Create": {
    "soapAction": "https://api.hostedshop.io/service.php#Currency_Create",
    "requestElement": "Currency_Create",
    "args": [
      { "name": "CurrencyData", "type": "tns:CurrencyCreate", "nillable": false, "required": true }
    ],
    "responseElement": "Currency_CreateResponse",
    "resultElement": "Currency_CreateResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new Currency"
  },
  "Currency_Update": {
    "soapAction": "https://api.hostedshop.io/service.php#Currency_Update",
    "requestElement": "Currency_Update",
    "args": [
      { "name": "CurrencyData", "type": "tns:CurrencyUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Currency_UpdateResponse",
    "resultElement": "Currency_UpdateResult",
    "resultType": "xsd:int",
    "documentation": "Updates a Currency"
  },
  "Currency_Delete": {
    "soapAction": "https://api.hostedshop.io/service.php#Currency_Delete",
    "requestElement": "Currency_Delete",
    "args": [
      { "name": "CurrencyId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Currency_DeleteResponse",
    "resultElement": "Currency_DeleteResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a Currency"
  },
  "Order_SetFields": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_SetFields",
    "requestElement": "Order_SetFields",
    "args": [
      { "name": "Fields", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Order_SetFieldsResponse",
    "resultElement": "Order_SetFieldsResult",
    "resultType": "xsd:boolean",
    "documentation": "Sets the output format for all methods returning Order Objects. If not set, the output format includes the Id"
  },
  "Order_GetAll": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetAll",
    "requestElement": "Order_GetAll",
    "args": [],
    "responseElement": "Order_GetAllResponse",
    "resultElement": "Order_GetAllResult",
    "resultType": "tns:ArrayOfOrder",
    "resultItemType": "tns:Order",
    "resultItemElement": "item",
    "documentation": "Returns information about all Orders. The output format can be set with Order_SetFields"
  },
  "Order_GetAllWithPagination": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetAllWithPagination",
    "requestElement": "Order_GetAllWithPagination",
    "args": [
      { "name": "Page", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "PageSize", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_GetAllWithPaginationResponse",
    "resultElement": "Order_GetAllWithPaginationResult",
    "resultType": "tns:ArrayOfOrder",
    "resultItemType": "tns:Order",
    "resultItemElement": "item",
    "documentation": "Returns paginated information about all Orders. The output format can be set with Order_SetFields"
  },
  "Order_CompleteTransaction": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_CompleteTransaction",
    "requestElement": "Order_CompleteTransaction",
    "args": [
      { "name": "TransactionCode", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_CompleteTransactionResponse",
    "resultElement": "Order_CompleteTransactionResult",
    "resultType": "xsd:string",
    "documentation": "Completes a transaction in the paymentgateway"
  },
  "Order_CancelTransaction": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_CancelTransaction",
    "requestElement": "Order_CancelTransaction",
    "args": [
      { "name": "TransactionCode", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_CancelTransactionResponse",
    "resultElement": "Order_CancelTransactionResult",
    "resultType": "xsd:string",
    "documentation": "Cancels a transaction in the paymentgateway"
  },
  "Order_LowerTransaction": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_LowerTransaction",
    "requestElement": "Order_LowerTransaction",
    "args": [
      { "name": "TransactionCode", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Amount", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_LowerTransactionResponse",
    "resultElement": "Order_LowerTransactionResult",
    "resultType": "xsd:string",
    "documentation": "Lowers a transaction in the paymentgateway"
  },
  "Order_ActivateKlarnaInvoice": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_ActivateKlarnaInvoice",
    "requestElement": "Order_ActivateKlarnaInvoice",
    "args": [
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_ActivateKlarnaInvoiceResponse",
    "resultElement": "Order_ActivateKlarnaInvoiceResult",
    "resultType": "xsd:boolean",
    "documentation": "Activates a klarna invoice"
  },
  "Order_CancelKlarnaInvoice": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_CancelKlarnaInvoice",
    "requestElement": "Order_CancelKlarnaInvoice",
    "args": [
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_CancelKlarnaInvoiceResponse",
    "resultElement": "Order_CancelKlarnaInvoiceResult",
    "resultType": "xsd:boolean",
    "documentation": "Cancels a klarna invoice"
  },
  "Order_GetByDate": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetByDate",
    "requestElement": "Order_GetByDate",
    "args": [
      { "name": "Start", "type": "xsd:string", "nillable": true, "required": true },
      { "name": "End", "type": "xsd:string", "nillable": true, "required": true },
      { "name": "Status", "type": "xsd:string", "nillable": true, "required": true }
    ],
    "responseElement": "Order_GetByDateResponse",
    "resultElement": "Order_GetByDateResult",
    "resultType": "tns:ArrayOfOrder",
    "resultItemType": "tns:Order",
    "resultItemElement": "item",
    "documentation": "Returns information about orders. The output format can be set with Order_SetFields"
  },
  "Order_GetByDateWithPagination": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetByDateWithPagination",
    "requestElement": "Order_GetByDateWithPagination",
    "args": [
      { "name": "Start", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "End", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Status", "type": "xsd:string", "nillable": true, "required": true },
      { "name": "Page", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "PageSize", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_GetByDateWithPaginationResponse",
    "resultElement": "Order_GetByDateWithPaginationResult",
    "resultType": "tns:ArrayOfOrder",
    "resultItemType": "tns:Order",
    "resultItemElement": "item",
    "documentation": "Returns paginated information about orders. The output format can be set with Order_SetFields"
  },
  "Order_GetByDateUpdated": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetByDateUpdated",
    "requestElement": "Order_GetByDateUpdated",
    "args": [
      { "name": "Start", "type": "xsd:string", "nillable": true, "required": true },
      { "name": "End", "type": "xsd:string", "nillable": true, "required": true },
      { "name": "Status", "type": "xsd:string", "nillable": true, "required": true }
    ],
    "responseElement": "Order_GetByDateUpdatedResponse",
    "resultElement": "Order_GetByDateUpdatedResult",
    "resultType": "tns:ArrayOfOrder",
    "resultItemType": "tns:Order",
    "resultItemElement": "item",
    "documentation": "Returns information about orders. The output format can be set with Order_SetFields"
  },
  "Order_GetByDateUpdatedWithPagination": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetByDateUpdatedWithPagination",
    "requestElement": "Order_GetByDateUpdatedWithPagination",
    "args": [
      { "name": "Start", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "End", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Status", "type": "xsd:string", "nillable": true, "required": true },
      { "name": "Page", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "PageSize", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_GetByDateUpdatedWithPaginationResponse",
    "resultElement": "Order_GetByDateUpdatedWithPaginationResult",
    "resultType": "tns:ArrayOfOrder",
    "resultItemType": "tns:Order",
    "resultItemElement": "item",
    "documentation": "Returns paginated information about orders. The output format can be set with Order_SetFields"
  },
  "Order_GetByDateAndUser": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetByDateAndUser",
    "requestElement": "Order_GetByDateAndUser",
    "args": [
      { "name": "Start", "type": "xsd:string", "nillable": true, "required": true },
      { "name": "End", "type": "xsd:string", "nillable": true, "required": true },
      { "name": "Status", "type": "xsd:string", "nillable": true, "required": true },
      { "name": "UserId", "type": "xsd:int", "nillable": true, "required": true }
    ],
    "responseElement": "Order_GetByDateAndUserResponse",
    "resultElement": "Order_GetByDateAndUserResult",
    "resultType": "tns:ArrayOfOrder",
    "resultItemType": "tns:Order",
    "resultItemElement": "item",
    "documentation": "Returns information about orders. The output format can be set with Order_SetFields"
  },
  "Order_GetByNumber": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetByNumber",
    "requestElement": "Order_GetByNumber",
    "args": [
      { "name": "Start", "type": "xsd:int", "nillable": true, "required": true },
      { "name": "End", "type": "xsd:int", "nillable": true, "required": true }
    ],
    "responseElement": "Order_GetByNumberResponse",
    "resultElement": "Order_GetByNumberResult",
    "resultType": "tns:ArrayOfOrder",
    "resultItemType": "tns:Order",
    "resultItemElement": "item",
    "documentation": "Returns information about orders. The output format can be set with Order_SetFields"
  },
  "Order_GetByStatus": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetByStatus",
    "requestElement": "Order_GetByStatus",
    "args": [
      { "name": "Status", "type": "xsd:string", "nillable": true, "required": true }
    ],
    "responseElement": "Order_GetByStatusResponse",
    "resultElement": "Order_GetByStatusResult",
    "resultType": "tns:ArrayOfOrder",
    "resultItemType": "tns:Order",
    "resultItemElement": "item",
    "documentation": "Returns information about orders. The output format can be set with Order_SetFields"
  },
  "Order_GetByStatusWithPagination": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetByStatusWithPagination",
    "requestElement": "Order_GetByStatusWithPagination",
    "args": [
      { "name": "Status", "type": "xsd:string", "nillable": true, "required": true },
      { "name": "Page", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "PageSize", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_GetByStatusWithPaginationResponse",
    "resultElement": "Order_GetByStatusWithPaginationResult",
    "resultType": "tns:ArrayOfOrder",
    "resultItemType": "tns:Order",
    "resultItemElement": "item",
    "documentation": "Returns paginated information about orders. The output format can be set with Order_SetFields"
  },
  "Order_GetById": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetById",
    "requestElement": "Order_GetById",
    "args": [
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_GetByIdResponse",
    "resultElement": "Order_GetByIdResult",
    "resultType": "tns:Order",
    "documentation": "Returns the indicated Order. The output format can be set with Order_SetFields"
  },
  "Order_GetBySite": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetBySite",
    "requestElement": "Order_GetBySite",
    "args": [
      { "name": "Site", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_GetBySiteResponse",
    "resultElement": "Order_GetBySiteResult",
    "resultType": "tns:Order",
    "documentation": "Returns the indicated Order. The output format can be set with Order_SetFields"
  },
  "Order_Create": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_Create",
    "requestElement": "Order_Create",
    "args": [
      { "name": "OrderData", "type": "tns:OrderCreate", "nillable": false, "required": true }
    ],
    "responseElement": "Order_CreateResponse",
    "resultElement": "Order_CreateResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new Order"
  },
  "Order_GetCurrency": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetCurrency",
    "requestElement": "Order_GetCurrency",
    "args": [
      { "name": "CurrencyId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_GetCurrencyResponse",
    "resultElement": "Order_GetCurrencyResult",
    "resultType": "tns:OrderCurrency",
    "documentation": "Returns the indicated OrderCurrency"
  },
  "Order_GetCustomer": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetCustomer",
    "requestElement": "Order_GetCustomer",
    "args": [
      { "name": "CustomerId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_GetCustomerResponse",
    "resultElement": "Order_GetCustomerResult",
    "resultType": "tns:OrderCustomer",
    "documentation": "Returns the indicated OrderCustomer"
  },
  "Order_GetDelivery": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetDelivery",
    "requestElement": "Order_GetDelivery",
    "args": [
      { "name": "DeliveryId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_GetDeliveryResponse",
    "resultElement": "Order_GetDeliveryResult",
    "resultType": "tns:OrderDelivery",
    "documentation": "Returns the indicated OrderDelivery"
  },
  "Order_GetDiscountCodes": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetDiscountCodes",
    "requestElement": "Order_GetDiscountCodes",
    "args": [
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_GetDiscountCodesResponse",
    "resultElement": "Order_GetDiscountCodesResult",
    "resultType": "tns:ArrayOfOrderdiscountcode",
    "resultItemType": "tns:OrderDiscountCode",
    "resultItemElement": "item",
    "documentation": "Returns the OrderDiscountCodes for the indicated Order"
  },
  "Order_SetOrderLineFields": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_SetOrderLineFields",
    "requestElement": "Order_SetOrderLineFields",
    "args": [
      { "name": "Fields", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Order_SetOrderLineFieldsResponse",
    "resultElement": "Order_SetOrderLineFieldsResult",
    "resultType": "xsd:boolean",
    "documentation": "Sets the outputformat for all methods returning OrderLine Objects. If not set, the output format includes only the Id"
  },
  "Order_GetLines": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetLines",
    "requestElement": "Order_GetLines",
    "args": [
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_GetLinesResponse",
    "resultElement": "Order_GetLinesResult",
    "resultType": "tns:ArrayOfOrderline",
    "resultItemType": "tns:OrderLine",
    "resultItemElement": "item",
    "documentation": "Returns the OrderLines of the indicated Order. The output format can be set with Order_SetOrderLineFields"
  },
  "Order_GetLineAddresses": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetLineAddresses",
    "requestElement": "Order_GetLineAddresses",
    "args": [
      { "name": "OrderLineId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_GetLineAddressesResponse",
    "resultElement": "Order_GetLineAddressesResult",
    "resultType": "tns:ArrayOfOrderlineaddress",
    "resultItemType": "tns:OrderLineAddress",
    "resultItemElement": "item",
    "documentation": "Returns the OrderLineAddresses of the indicated OrderLine."
  },
  "Order_GetPacking": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetPacking",
    "requestElement": "Order_GetPacking",
    "args": [
      { "name": "PackingId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_GetPackingResponse",
    "resultElement": "Order_GetPackingResult",
    "resultType": "tns:OrderPacking",
    "documentation": "Returns the indicated OrderPacking"
  },
  "Order_GetPayment": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetPayment",
    "requestElement": "Order_GetPayment",
    "args": [
      { "name": "PaymentId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_GetPaymentResponse",
    "resultElement": "Order_GetPaymentResult",
    "resultType": "tns:OrderPayment",
    "documentation": "Returns the indicated OrderPayment"
  },
  "Order_GetTransactions": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetTransactions",
    "requestElement": "Order_GetTransactions",
    "args": [
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_GetTransactionsResponse",
    "resultElement": "Order_GetTransactionsResult",
    "resultType": "tns:ArrayOfOrdertransaction",
    "resultItemType": "tns:OrderTransaction",
    "resultItemElement": "item",
    "documentation": "Returns the OrderTransactions of the indicated Order"
  },
  "Order_UpdateStatus": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_UpdateStatus",
    "requestElement": "Order_UpdateStatus",
    "args": [
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Status", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_UpdateStatusResponse",
    "resultElement": "Order_UpdateStatusResult",
    "resultType": "xsd:boolean",
    "documentation": "Updates the order status"
  },
  "Order_UpdateSite": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_UpdateSite",
    "requestElement": "Order_UpdateSite",
    "args": [
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Site", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_UpdateSiteResponse",
    "resultElement": "Order_UpdateSiteResult",
    "resultType": "xsd:boolean",
    "documentation": "Updates the order site"
  },
  "Product_UpdateStockForStockLocation": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_UpdateStockForStockLocation",
    "requestElement": "Product_UpdateStockForStockLocation",
    "args": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "StockLocationId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Stock", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_UpdateStockForStockLocationResponse",
    "resultElement": "Product_UpdateStockForStockLocationResult",
    "resultType": "xsd:boolean",
    "documentation": "Updates the stock of a stock location for a product"
  },
  "Product_UpdateVariantStockForStockLocation": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_UpdateVariantStockForStockLocation",
    "requestElement": "Product_UpdateVariantStockForStockLocation",
    "args": [
      { "name": "VariantId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "StockLocationId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Stock", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_UpdateVariantStockForStockLocationResponse",
    "resultElement": "Product_UpdateVariantStockForStockLocationResult",
    "resultType": "xsd:boolean",
    "documentation": "Updates the stock of a stock location for a variant"
  },
  "Order_UpdateTrackingCode": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_UpdateTrackingCode",
    "requestElement": "Order_UpdateTrackingCode",
    "args": [
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "TrackingCode", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Order_UpdateTrackingCodeResponse",
    "resultElement": "Order_UpdateTrackingCodeResult",
    "resultType": "xsd:boolean",
    "documentation": "Updates the order trackingcode"
  },
  "Order_UpdateLineStatus": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_UpdateLineStatus",
    "requestElement": "Order_UpdateLineStatus",
    "args": [
      { "name": "OrderLineId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Status", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_UpdateLineStatusResponse",
    "resultElement": "Order_UpdateLineStatusResult",
    "resultType": "xsd:boolean",
    "documentation": "Updates the status of an order line"
  },
  "Order_UpdateLineTrackingCode": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_UpdateLineTrackingCode",
    "requestElement": "Order_UpdateLineTrackingCode",
    "args": [
      { "name": "OrderLineId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "TrackingCode", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Order_UpdateLineTrackingCodeResponse",
    "resultElement": "Order_UpdateLineTrackingCodeResult",
    "resultType": "xsd:boolean",
    "documentation": "Updates the trackingcode of an order line"
  },
  "Order_UpdateComment": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_UpdateComment",
    "requestElement": "Order_UpdateComment",
    "args": [
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Text", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Order_UpdateCommentResponse",
    "resultElement": "Order_UpdateCommentResult",
    "resultType": "xsd:boolean",
    "documentation": "Updates the comment of the order"
  },
  "Order_GetFileDownload": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_GetFileDownload",
    "requestElement": "Order_GetFileDownload",
    "args": [
      { "name": "FileDownloadId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_GetFileDownloadResponse",
    "resultElement": "Order_GetFileDownloadResult",
    "resultType": "tns:OrderFileDownload",
    "documentation": "Returns the indicated OrderFileDownload"
  },
  "Order_CreateInvoice": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_CreateInvoice",
    "requestElement": "Order_CreateInvoice",
    "args": [
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "MaturityDayInterval", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_CreateInvoiceResponse",
    "resultElement": "Order_CreateInvoiceResult",
    "resultType": "xsd:boolean",
    "documentation": "Creates an invoice with a maturity date for an Order"
  },
  "Order_UploadInvoice": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_UploadInvoice",
    "requestElement": "Order_UploadInvoice",
    "args": [
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "InvoiceNumber", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "FileContent", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Order_UploadInvoiceResponse",
    "resultElement": "Order_UploadInvoiceResult",
    "resultType": "xsd:boolean",
    "documentation": "Uploads an invoice file for an Order"
  },
  "OrderStatusCode_GetAll": {
    "soapAction": "https://api.hostedshop.io/service.php#OrderStatusCode_GetAll",
    "requestElement": "OrderStatusCode_GetAll",
    "args": [],
    "responseElement": "OrderStatusCode_GetAllResponse",
    "resultElement": "OrderStatusCode_GetAllResult",
    "resultType": "tns:ArrayOfOrderStatusCode",
    "resultItemType": "tns:OrderStatusCode",
    "resultItemElement": "item",
    "documentation": "Returns an array of all OrderStatusCode"
  },
  "Order_SetTransactionCode": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_SetTransactionCode",
    "requestElement": "Order_SetTransactionCode",
    "args": [
      { "name": "TransactionData", "type": "tns:OrderSetTransactionCode", "nillable": false, "required": true }
    ],
    "responseElement": "Order_SetTransactionCodeResponse",
    "resultElement": "Order_SetTransactionCodeResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new order transaction"
  },
  "Product_SetFields": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_SetFields",
    "requestElement": "Product_SetFields",
    "args": [
      { "name": "Fields", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Product_SetFieldsResponse",
    "resultElement": "Product_SetFieldsResult",
    "resultType": "xsd:boolean",
    "documentation": "Sets the outputformat for all methods returning Product Objects. If not set, the output format includes the Id"
  },
  "Product_GetAll": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetAll",
    "requestElement": "Product_GetAll",
    "args": [],
    "responseElement": "Product_GetAllResponse",
    "resultElement": "Product_GetAllResult",
    "resultType": "tns:ArrayOfProduct",
    "resultItemType": "tns:Product",
    "resultItemElement": "item",
    "documentation": "Returns information about Products. The output format can be set with Product_SetFields"
  },
  "Product_GetAllWithLimit": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetAllWithLimit",
    "requestElement": "Product_GetAllWithLimit",
    "args": [
      { "name": "Start", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Length", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetAllWithLimitResponse",
    "resultElement": "Product_GetAllWithLimitResult",
    "resultType": "tns:ArrayOfProduct",
    "resultItemType": "tns:Product",
    "resultItemElement": "item",
    "documentation": "Equal to Product_GetAll, however it returns only $Length amount of products starting as index $Start. The output format can be set with Product_SetFields"
  },
  "Product_GetByUpdatedDate": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetByUpdatedDate",
    "requestElement": "Product_GetByUpdatedDate",
    "args": [
      { "name": "Start", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "End", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetByUpdatedDateResponse",
    "resultElement": "Product_GetByUpdatedDateResult",
    "resultType": "tns:ArrayOfProduct",
    "resultItemType": "tns:Product",
    "resultItemElement": "item",
    "documentation": "Returns information about Products that have been updated within the supplied start- and end dates. The output format can be set with Product_SetFields"
  },
  "Product_GetByCategory": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetByCategory",
    "requestElement": "Product_GetByCategory",
    "args": [
      { "name": "CategoryId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetByCategoryResponse",
    "resultElement": "Product_GetByCategoryResult",
    "resultType": "tns:ArrayOfProduct",
    "resultItemType": "tns:Product",
    "resultItemElement": "item",
    "documentation": "Returns the products with this category as their main category. The output format can be set with Product_SetFields"
  },
  "Product_GetByCategoryAndSecondary": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetByCategoryAndSecondary",
    "requestElement": "Product_GetByCategoryAndSecondary",
    "args": [
      { "name": "CategoryId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetByCategoryAndSecondaryResponse",
    "resultElement": "Product_GetByCategoryAndSecondaryResult",
    "resultType": "tns:ArrayOfProduct",
    "resultItemType": "tns:Product",
    "resultItemElement": "item",
    "documentation": "Returns the products with this category as their main or secondary category. The output format can be set with Product_SetFields"
  },
  "Product_GetById": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetById",
    "requestElement": "Product_GetById",
    "args": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetByIdResponse",
    "resultElement": "Product_GetByIdResult",
    "resultType": "tns:Product",
    "documentation": "Returns the indicated Product. The output format can be set with Product_SetFields"
  },
  "Product_GetByIds": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetByIds",
    "requestElement": "Product_GetByIds",
    "args": [
      { "name": "ProductIds", "type": "tns:ArrayOfInt", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetByIdsResponse",
    "resultElement": "Product_GetByIdsResult",
    "resultType": "tns:ArrayOfProduct",
    "resultItemType": "tns:Product",
    "resultItemElement": "item",
    "documentation": "Returns the indicated Product. The output format can be set with Product_SetFields"
  },
  "Product_GetByItemNumber": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetByItemNumber",
    "requestElement": "Product_GetByItemNumber",
    "args": [
      { "name": "ItemNumber", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetByItemNumberResponse",
    "resultElement": "Product_GetByItemNumberResult",
    "resultType": "tns:ArrayOfProduct",
    "resultItemType": "tns:Product",
    "resultItemElement": "item",
    "documentation": "Returns the indicated Product. The output format can be set with Product_SetFields"
  },
  "Product_GetByBrand": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetByBrand",
    "requestElement": "Product_GetByBrand",
    "args": [
      { "name": "BrandId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetByBrandResponse",
    "resultElement": "Product_GetByBrandResult",
    "resultType": "tns:ArrayOfProduct",
    "resultItemType": "tns:Product",
    "resultItemElement": "item",
    "documentation": "Returns the products with this brand. The output format can be set with Product_SetFields"
  },
  "Product_Create": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_Create",
    "requestElement": "Product_Create",
    "args": [
      { "name": "ProductData", "type": "tns:ProductCreate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_CreateResponse",
    "resultElement": "Product_CreateResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new Product"
  },
  "Product_Update": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_Update",
    "requestElement": "Product_Update",
    "args": [
      { "name": "ProductData", "type": "tns:ProductUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_UpdateResponse",
    "resultElement": "Product_UpdateResult",
    "resultType": "tns:ArrayOfInt",
    "resultItemType": "xsd:int",
    "resultItemElement": "item",
    "documentation": "Updates a Product. Either Id or Itemnumber can be used as identifier. If Itemnumber is used, this call might update several Products in case they have the same Itemnumber."
  },
  "Product_CreateOrUpdate": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_CreateOrUpdate",
    "requestElement": "Product_CreateOrUpdate",
    "args": [
      { "name": "ProductData", "type": "tns:ProductCreateUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_CreateOrUpdateResponse",
    "resultElement": "Product_CreateOrUpdateResult",
    "resultType": "xsd:int",
    "documentation": "Creates or Updates a Product using its ItemNumber as key. Assumes that only unique ItemNumbers exist in the shop. If the Itemnumber supplied is not found a new product is created"
  },
  "Product_CreateOrUpdateBulk": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_CreateOrUpdateBulk",
    "requestElement": "Product_CreateOrUpdateBulk",
    "args": [
      { "name": "ProductDataList", "type": "tns:ArrayOfProductCreateUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_CreateOrUpdateBulkResponse",
    "resultElement": "Product_CreateOrUpdateBulkResult",
    "resultType": "tns:ArrayOfProductCreateOrUpdateBulkResult",
    "resultItemType": "tns:ProductCreateOrUpdateBulkResult",
    "resultItemElement": "item",
    "documentation": "Creates or Updates multiple Products in a single call using ItemNumber as key. Assumes that only unique ItemNumbers exist in the shop. If an ItemNumber is not found a new product is created. Returns an array of results with Id for success or Error message for failure."
  },
  "Product_GetAdditionals": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetAdditionals",
    "requestElement": "Product_GetAdditionals",
    "args": [
      { "name": "AdditionalTypeId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetAdditionalsResponse",
    "resultElement": "Product_GetAdditionalsResult",
    "resultType": "tns:ArrayOfProductadditional",
    "resultItemType": "tns:ProductAdditional",
    "resultItemElement": "item",
    "documentation": "Returns the ProductAdditionals of the indicated ProductAdditionalType"
  },
  "Product_GetAdditionalTypesAll": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetAdditionalTypesAll",
    "requestElement": "Product_GetAdditionalTypesAll",
    "args": [],
    "responseElement": "Product_GetAdditionalTypesAllResponse",
    "resultElement": "Product_GetAdditionalTypesAllResult",
    "resultType": "tns:ArrayOfProductadditionaltype",
    "resultItemType": "tns:ProductAdditionalType",
    "resultItemElement": "item",
    "documentation": "Returns all ProductAdditionalTypes of the solution"
  },
  "Product_GetAdditionalTypes": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetAdditionalTypes",
    "requestElement": "Product_GetAdditionalTypes",
    "args": [
      { "name": "ProductId", "type": "xsd:int", "nillable": true, "required": true }
    ],
    "responseElement": "Product_GetAdditionalTypesResponse",
    "resultElement": "Product_GetAdditionalTypesResult",
    "resultType": "tns:ArrayOfProductadditionaltype",
    "resultItemType": "tns:ProductAdditionalType",
    "resultItemElement": "item",
    "documentation": "Returns the ProductAdditionalTypes of the indicated Product"
  },
  "Product_AddAdditionalType": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_AddAdditionalType",
    "requestElement": "Product_AddAdditionalType",
    "args": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "AdditionalTypeId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_AddAdditionalTypeResponse",
    "resultElement": "Product_AddAdditionalTypeResult",
    "resultType": "xsd:boolean",
    "documentation": "Adds an existing ProductAdditionalType to the indicated Product"
  },
  "Product_RemoveAdditionalType": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_RemoveAdditionalType",
    "requestElement": "Product_RemoveAdditionalType",
    "args": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "AdditionalTypeId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_RemoveAdditionalTypeResponse",
    "resultElement": "Product_RemoveAdditionalTypeResult",
    "resultType": "xsd:boolean",
    "documentation": "Removes a ProductAdditionalType from the indicated Product"
  },
  "Product_CreateCustomData": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_CreateCustomData",
    "requestElement": "Product_CreateCustomData",
    "args": [
      { "name": "ProductCustomData", "type": "tns:ProductCustomDataCreate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_CreateCustomDataResponse",
    "resultElement": "Product_CreateCustomDataResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new ProductCustomData"
  },
  "Product_UpdateCustomData": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_UpdateCustomData",
    "requestElement": "Product_UpdateCustomData",
    "args": [
      { "name": "ProductCustomData", "type": "tns:ProductCustomDataUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_UpdateCustomDataResponse",
    "resultElement": "Product_UpdateCustomDataResult",
    "resultType": "xsd:int",
    "documentation": "Upates a ProductCustomData"
  },
  "Product_GetCustomDataAll": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetCustomDataAll",
    "requestElement": "Product_GetCustomDataAll",
    "args": [],
    "responseElement": "Product_GetCustomDataAllResponse",
    "resultElement": "Product_GetCustomDataAllResult",
    "resultType": "tns:ArrayOfProductcustomdata",
    "resultItemType": "tns:ProductCustomData",
    "resultItemElement": "item",
    "documentation": "Returns all ProductCustomData of the solution"
  },
  "Product_GetCustomData": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetCustomData",
    "requestElement": "Product_GetCustomData",
    "args": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetCustomDataResponse",
    "resultElement": "Product_GetCustomDataResult",
    "resultType": "tns:ArrayOfProductcustomdata",
    "resultItemType": "tns:ProductCustomData",
    "resultItemElement": "item",
    "documentation": "Returns the ProductCustomData of the indicated Product"
  },
  "Product_GetCustomDataById": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetCustomDataById",
    "requestElement": "Product_GetCustomDataById",
    "args": [
      { "name": "CustomDataId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetCustomDataByIdResponse",
    "resultElement": "Product_GetCustomDataByIdResult",
    "resultType": "tns:ProductCustomData",
    "documentation": "Returns the indicated ProductCustomData"
  },
  "Product_GetCustomDataByType": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetCustomDataByType",
    "requestElement": "Product_GetCustomDataByType",
    "args": [
      { "name": "CustomDataTypeId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetCustomDataByTypeResponse",
    "resultElement": "Product_GetCustomDataByTypeResult",
    "resultType": "tns:ArrayOfProductcustomdata",
    "resultItemType": "tns:ProductCustomData",
    "resultItemElement": "item",
    "documentation": "Returns the ProductCustomDatas of the indicated ProductCustomDataType"
  },
  "Product_CreateCustomDataType": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_CreateCustomDataType",
    "requestElement": "Product_CreateCustomDataType",
    "args": [
      { "name": "ProductCustomDataType", "type": "tns:ProductCustomDataTypeCreate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_CreateCustomDataTypeResponse",
    "resultElement": "Product_CreateCustomDataTypeResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new ProductCustomDataType"
  },
  "Product_UpdateCustomDataType": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_UpdateCustomDataType",
    "requestElement": "Product_UpdateCustomDataType",
    "args": [
      { "name": "ProductCustomDataType", "type": "tns:ProductCustomDataTypeUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_UpdateCustomDataTypeResponse",
    "resultElement": "Product_UpdateCustomDataTypeResult",
    "resultType": "xsd:int",
    "documentation": "Upates a ProductCustomDataType"
  },
  "Product_AddCustomData": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_AddCustomData",
    "requestElement": "Product_AddCustomData",
    "args": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "CustomDataId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_AddCustomDataResponse",
    "resultElement": "Product_AddCustomDataResult",
    "resultType": "xsd:boolean",
    "documentation": "Adds an existing ProductCostumData to the indicated Product"
  },
  "Product_RemoveCustomData": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_RemoveCustomData",
    "requestElement": "Product_RemoveCustomData",
    "args": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "CustomDataId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_RemoveCustomDataResponse",
    "resultElement": "Product_RemoveCustomDataResult",
    "resultType": "xsd:boolean",
    "documentation": "Removes a ProductCostumData from the indicated Product"
  },
  "Product_UpdateCustomTextData": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_UpdateCustomTextData",
    "requestElement": "Product_UpdateCustomTextData",
    "args": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "CustomDataTypeId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Text", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Product_UpdateCustomTextDataResponse",
    "resultElement": "Product_UpdateCustomTextDataResult",
    "resultType": "xsd:boolean",
    "documentation": "Updates the text of a 'textype' ProductCostumData for the indicated Product"
  },
  "Product_DeleteCustomData": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_DeleteCustomData",
    "requestElement": "Product_DeleteCustomData",
    "args": [
      { "name": "ProductCustomDataId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_DeleteCustomDataResponse",
    "resultElement": "Product_DeleteCustomDataResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a ProductCustomData"
  },
  "Product_GetCustomDataType": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetCustomDataType",
    "requestElement": "Product_GetCustomDataType",
    "args": [
      { "name": "CustomDataTypeId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetCustomDataTypeResponse",
    "resultElement": "Product_GetCustomDataTypeResult",
    "resultType": "tns:ProductCustomDataType",
    "documentation": "Returns the indicated ProductCustomDataType"
  },
  "Product_GetCustomDataTypeAll": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetCustomDataTypeAll",
    "requestElement": "Product_GetCustomDataTypeAll",
    "args": [],
    "responseElement": "Product_GetCustomDataTypeAllResponse",
    "resultElement": "Product_GetCustomDataTypeAllResult",
    "resultType": "tns:ArrayOfProductcustomdatatype",
    "resultItemType": "tns:ProductCustomDataType",
    "resultItemElement": "item",
    "documentation": "Returns all ProductCustomDataTypes"
  },
  "Product_DeleteCustomDataType": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_DeleteCustomDataType",
    "requestElement": "Product_DeleteCustomDataType",
    "args": [
      { "name": "ProductCustomDataTypeId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_DeleteCustomDataTypeResponse",
    "resultElement": "Product_DeleteCustomDataTypeResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a ProductCustomDataType"
  },
  "Product_GetDiscountGroup": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetDiscountGroup",
    "requestElement": "Product_GetDiscountGroup",
    "args": [
      { "name": "DiscountGroupId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetDiscountGroupResponse",
    "resultElement": "Product_GetDiscountGroupResult",
    "resultType": "tns:DiscountGroup",
    "documentation": "Returns the indicated DiscountGroup"
  },
  "DiscountGroup_GetById": {
    "soapAction": "https://api.hostedshop.io/service.php#DiscountGroup_GetById",
    "requestElement": "DiscountGroup_GetById",
    "args": [
      { "name": "DiscountGroupId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "DiscountGroup_GetByIdResponse",
    "resultElement": "DiscountGroup_GetByIdResult",
    "resultType": "tns:DiscountGroup",
    "documentation": "Returns the indicated DiscountGroup"
  },
  "DiscountGroup_GetByTitle": {
    "soapAction": "https://api.hostedshop.io/service.php#DiscountGroup_GetByTitle",
    "requestElement": "DiscountGroup_GetByTitle",
    "args": [
      { "name": "DiscountGroupTitle", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "DiscountGroup_GetByTitleResponse",
    "resultElement": "DiscountGroup_GetByTitleResult",
    "resultType": "tns:DiscountGroup",
    "documentation": "Returns the indicated DiscountGroup"
  },
  "DiscountGroup_GetAll": {
    "soapAction": "https://api.hostedshop.io/service.php#DiscountGroup_GetAll",
    "requestElement": "DiscountGroup_GetAll",
    "args": [],
    "responseElement": "DiscountGroup_GetAllResponse",
    "resultElement": "DiscountGroup_GetAllResult",
    "resultType": "tns:ArrayOfDiscountgroup",
    "resultItemType": "tns:DiscountGroup",
    "resultItemElement": "item",
    "documentation": "Returns all DiscountGroups"
  },
  "DiscountGroup_Create": {
    "soapAction": "https://api.hostedshop.io/service.php#DiscountGroup_Create",
    "requestElement": "DiscountGroup_Create",
    "args": [
      { "name": "DiscountGroupData", "type": "tns:DiscountGroupCreate", "nillable": false, "required": true }
    ],
    "responseElement": "DiscountGroup_CreateResponse",
    "resultElement": "DiscountGroup_CreateResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new DiscountGroup"
  },
  "DiscountGroup_Update": {
    "soapAction": "https://api.hostedshop.io/service.php#DiscountGroup_Update",
    "requestElement": "DiscountGroup_Update",
    "args": [
      { "name": "DiscountGroupData", "type": "tns:DiscountGroupUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "DiscountGroup_UpdateResponse",
    "resultElement": "DiscountGroup_UpdateResult",
    "resultType": "xsd:int",
    "documentation": "Updates a DiscountGroup"
  },
  "DiscountGroup_Delete": {
    "soapAction": "https://api.hostedshop.io/service.php#DiscountGroup_Delete",
    "requestElement": "DiscountGroup_Delete",
    "args": [
      { "name": "DiscountGroupId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "DiscountGroup_DeleteResponse",
    "resultElement": "DiscountGroup_DeleteResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a DiscountGroup"
  },
  "DiscountGroupProduct_GetById": {
    "soapAction": "https://api.hostedshop.io/service.php#DiscountGroupProduct_GetById",
    "requestElement": "DiscountGroupProduct_GetById",
    "args": [
      { "name": "DiscountGroupProductId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "DiscountGroupProduct_GetByIdResponse",
    "resultElement": "DiscountGroupProduct_GetByIdResult",
    "resultType": "tns:DiscountGroupProduct",
    "documentation": "Returns the indicated DiscountGroupProduct"
  },
  "DiscountGroupProduct_GetByTitle": {
    "soapAction": "https://api.hostedshop.io/service.php#DiscountGroupProduct_GetByTitle",
    "requestElement": "DiscountGroupProduct_GetByTitle",
    "args": [
      { "name": "DiscountGroupProductTitle", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "DiscountGroupProduct_GetByTitleResponse",
    "resultElement": "DiscountGroupProduct_GetByTitleResult",
    "resultType": "tns:DiscountGroupProduct",
    "documentation": "Returns the indicated DiscountGroupProduct"
  },
  "DiscountGroupProduct_GetAll": {
    "soapAction": "https://api.hostedshop.io/service.php#DiscountGroupProduct_GetAll",
    "requestElement": "DiscountGroupProduct_GetAll",
    "args": [],
    "responseElement": "DiscountGroupProduct_GetAllResponse",
    "resultElement": "DiscountGroupProduct_GetAllResult",
    "resultType": "tns:ArrayOfDiscountgroupproduct",
    "resultItemType": "tns:DiscountGroupProduct",
    "resultItemElement": "item",
    "documentation": "Returns all DiscountGroupProducts"
  },
  "DiscountGroupProduct_Create": {
    "soapAction": "https://api.hostedshop.io/service.php#DiscountGroupProduct_Create",
    "requestElement": "DiscountGroupProduct_Create",
    "args": [
      { "name": "DiscountGroupProductData", "type": "tns:DiscountGroupProductCreate", "nillable": false, "required": true }
    ],
    "responseElement": "DiscountGroupProduct_CreateResponse",
    "resultElement": "DiscountGroupProduct_CreateResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new DiscountGroupProduct"
  },
  "DiscountGroupProduct_Update": {
    "soapAction": "https://api.hostedshop.io/service.php#DiscountGroupProduct_Update",
    "requestElement": "DiscountGroupProduct_Update",
    "args": [
      { "name": "DiscountGroupProductData", "type": "tns:DiscountGroupProductUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "DiscountGroupProduct_UpdateResponse",
    "resultElement": "DiscountGroupProduct_UpdateResult",
    "resultType": "xsd:int",
    "documentation": "Updates a DiscountGroupProduct"
  },
  "DiscountGroupProduct_Delete": {
    "soapAction": "https://api.hostedshop.io/service.php#DiscountGroupProduct_Delete",
    "requestElement": "DiscountGroupProduct_Delete",
    "args": [
      { "name": "DiscounProducttGroupTitle", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "DiscountGroupProduct_DeleteResponse",
    "resultElement": "DiscountGroupProduct_DeleteResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a DiscountGroupProduct"
  },
  "Product_GetExtraBuyRelations": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetExtraBuyRelations",
    "requestElement": "Product_GetExtraBuyRelations",
    "args": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetExtraBuyRelationsResponse",
    "resultElement": "Product_GetExtraBuyRelationsResult",
    "resultType": "tns:ArrayOfProductextrabuyrelation",
    "resultItemType": "tns:ProductExtraBuyRelation",
    "resultItemElement": "item",
    "documentation": "Returns the ProductExtraBuyRelations of the indicated Product"
  },
  "Product_CreateExtraBuyRelation": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_CreateExtraBuyRelation",
    "requestElement": "Product_CreateExtraBuyRelation",
    "args": [
      { "name": "ExtraBuyRelationData", "type": "tns:ProductExtraBuyRelationCreate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_CreateExtraBuyRelationResponse",
    "resultElement": "Product_CreateExtraBuyRelationResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new ProductExtraBuyRelation"
  },
  "Product_UpdateExtraBuyRelation": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_UpdateExtraBuyRelation",
    "requestElement": "Product_UpdateExtraBuyRelation",
    "args": [
      { "name": "ExtraBuyRelationData", "type": "tns:ProductExtraBuyRelationUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_UpdateExtraBuyRelationResponse",
    "resultElement": "Product_UpdateExtraBuyRelationResult",
    "resultType": "xsd:int",
    "documentation": "Updates a ProductExtraBuyRelation"
  },
  "Product_DeleteExtraBuyRelation": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_DeleteExtraBuyRelation",
    "requestElement": "Product_DeleteExtraBuyRelation",
    "args": [
      { "name": "ProductExtraBuyRelationId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_DeleteExtraBuyRelationResponse",
    "resultElement": "Product_DeleteExtraBuyRelationResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a ProductExtraBuyRelation"
  },
  "Product_GetAllExtraBuyCategory": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetAllExtraBuyCategory",
    "requestElement": "Product_GetAllExtraBuyCategory",
    "args": [],
    "responseElement": "Product_GetAllExtraBuyCategoryResponse",
    "resultElement": "Product_GetAllExtraBuyCategoryResult",
    "resultType": "tns:ArrayOfProductextrabuycategory",
    "resultItemType": "tns:ProductExtraBuyCategory",
    "resultItemElement": "item",
    "documentation": "Returns all ProductExtraBuyCategories"
  },
  "Product_GetExtraBuyCategory": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetExtraBuyCategory",
    "requestElement": "Product_GetExtraBuyCategory",
    "args": [
      { "name": "ExtraBuyCategoryId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetExtraBuyCategoryResponse",
    "resultElement": "Product_GetExtraBuyCategoryResult",
    "resultType": "tns:ProductExtraBuyCategory",
    "documentation": "Returns the indicated ProductExtraBuyCategory"
  },
  "Product_CreateExtraBuyCategory": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_CreateExtraBuyCategory",
    "requestElement": "Product_CreateExtraBuyCategory",
    "args": [
      { "name": "ExtraBuyCategoryData", "type": "tns:ProductExtraBuyCategoryCreate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_CreateExtraBuyCategoryResponse",
    "resultElement": "Product_CreateExtraBuyCategoryResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new ProductExtraBuyCategory"
  },
  "Product_UpdateExtraBuyCategory": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_UpdateExtraBuyCategory",
    "requestElement": "Product_UpdateExtraBuyCategory",
    "args": [
      { "name": "ExtraBuyCategoryData", "type": "tns:ProductExtraBuyCategoryUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_UpdateExtraBuyCategoryResponse",
    "resultElement": "Product_UpdateExtraBuyCategoryResult",
    "resultType": "xsd:int",
    "documentation": "Updates a ProductExtraBuyCategory"
  },
  "Product_DeleteExtraBuyCategory": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_DeleteExtraBuyCategory",
    "requestElement": "Product_DeleteExtraBuyCategory",
    "args": [
      { "name": "ProductExtraBuyCategoryId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_DeleteExtraBuyCategoryResponse",
    "resultElement": "Product_DeleteExtraBuyCategoryResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a ProductExtraBuyCategory"
  },
  "Product_SetVariantFields": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_SetVariantFields",
    "requestElement": "Product_SetVariantFields",
    "args": [
      { "name": "Fields", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Product_SetVariantFieldsResponse",
    "resultElement": "Product_SetVariantFieldsResult",
    "resultType": "xsd:boolean",
    "documentation": "Sets the output format for all methods returning ProductVariant Objects. If not set, the output format includes the Id"
  },
  "Product_GetVariants": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetVariants",
    "requestElement": "Product_GetVariants",
    "args": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetVariantsResponse",
    "resultElement": "Product_GetVariantsResult",
    "resultType": "tns:ArrayOfProductvariant",
    "resultItemType": "tns:ProductVariant",
    "resultItemElement": "item",
    "documentation": "Returns the ProductVariants of the indicated Product"
  },
  "Product_GetVariantsByItemNumber": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetVariantsByItemNumber",
    "requestElement": "Product_GetVariantsByItemNumber",
    "args": [
      { "name": "ItemNumber", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetVariantsByItemNumberResponse",
    "resultElement": "Product_GetVariantsByItemNumberResult",
    "resultType": "tns:ArrayOfProductvariant",
    "resultItemType": "tns:ProductVariant",
    "resultItemElement": "item",
    "documentation": "Returns the ProductVariant(s) with the indicated ItemNumber"
  },
  "Product_GetVariantById": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetVariantById",
    "requestElement": "Product_GetVariantById",
    "args": [
      { "name": "VariantId", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetVariantByIdResponse",
    "resultElement": "Product_GetVariantByIdResult",
    "resultType": "tns:ProductVariant",
    "documentation": "Returns the ProductVariant with the indicated id"
  },
  "Product_CreateOrUpdateVariantType": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_CreateOrUpdateVariantType",
    "requestElement": "Product_CreateOrUpdateVariantType",
    "args": [
      { "name": "VariantTypeData", "type": "tns:ProductVariantTypeCreateUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_CreateOrUpdateVariantTypeResponse",
    "resultElement": "Product_CreateOrUpdateVariantTypeResult",
    "resultType": "xsd:int",
    "documentation": "Creates or Updates a ProductVariantType using Title as key. Assumes that only unique ProductVariantType Titles in a given language exist in the shop. If the Title supplied is not found a new ProductVariantType is created"
  },
  "Product_UpdateVariantType": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_UpdateVariantType",
    "requestElement": "Product_UpdateVariantType",
    "args": [
      { "name": "VariantTypeData", "type": "tns:ProductVariantTypeUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_UpdateVariantTypeResponse",
    "resultElement": "Product_UpdateVariantTypeResult",
    "resultType": "xsd:int",
    "documentation": "Updates a ProductVariantType"
  },
  "Product_GetVariantTypeAll": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetVariantTypeAll",
    "requestElement": "Product_GetVariantTypeAll",
    "args": [],
    "responseElement": "Product_GetVariantTypeAllResponse",
    "resultElement": "Product_GetVariantTypeAllResult",
    "resultType": "tns:ArrayOfProductvarianttype",
    "resultItemType": "tns:ProductVariantType",
    "resultItemElement": "item",
    "documentation": "Returns all ProductVariantTypes."
  },
  "Product_GetVariantType": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetVariantType",
    "requestElement": "Product_GetVariantType",
    "args": [
      { "name": "VariantTypeId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetVariantTypeResponse",
    "resultElement": "Product_GetVariantTypeResult",
    "resultType": "tns:ProductVariantType",
    "documentation": "Returns the indicated ProductVariantType"
  },
  "Product_CreateOrUpdateVariantTypeValue": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_CreateOrUpdateVariantTypeValue",
    "requestElement": "Product_CreateOrUpdateVariantTypeValue",
    "args": [
      { "name": "VariantTypeValueData", "type": "tns:ProductVariantTypeValueCreateUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_CreateOrUpdateVariantTypeValueResponse",
    "resultElement": "Product_CreateOrUpdateVariantTypeValueResult",
    "resultType": "xsd:int",
    "documentation": "Creates or Updates a ProductVariantTypeValue using Title and ProductVariantType id as keys. If the Title supplied is not found a new ProductVariantTypeValue is created"
  },
  "Product_UpdateVariantTypeValue": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_UpdateVariantTypeValue",
    "requestElement": "Product_UpdateVariantTypeValue",
    "args": [
      { "name": "VariantTypeValueData", "type": "tns:ProductVariantTypeValueUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_UpdateVariantTypeValueResponse",
    "resultElement": "Product_UpdateVariantTypeValueResult",
    "resultType": "xsd:int",
    "documentation": "Updates a ProductVariantTypeValue"
  },
  "Product_GetVariantTypeValues": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetVariantTypeValues",
    "requestElement": "Product_GetVariantTypeValues",
    "args": [
      { "name": "VariantId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetVariantTypeValuesResponse",
    "resultElement": "Product_GetVariantTypeValuesResult",
    "resultType": "tns:ArrayOfProductvarianttypevalue",
    "resultItemType": "tns:ProductVariantTypeValue",
    "resultItemElement": "item",
    "documentation": "Returns the ProductVariantTypeValues of the indicated Variant"
  },
  "Product_GetVariantTypeValuesByType": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetVariantTypeValuesByType",
    "requestElement": "Product_GetVariantTypeValuesByType",
    "args": [
      { "name": "VariantTypeId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetVariantTypeValuesByTypeResponse",
    "resultElement": "Product_GetVariantTypeValuesByTypeResult",
    "resultType": "tns:ArrayOfProductvarianttypevalue",
    "resultItemType": "tns:ProductVariantTypeValue",
    "resultItemElement": "item",
    "documentation": "Returns the ProductVariantTypeValues of the indicated ProductVariantType"
  },
  "Product_GetVariantTypeValue": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetVariantTypeValue",
    "requestElement": "Product_GetVariantTypeValue",
    "args": [
      { "name": "TypeValueId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetVariantTypeValueResponse",
    "resultElement": "Product_GetVariantTypeValueResult",
    "resultType": "tns:ProductVariantTypeValue",
    "documentation": "Returns the ProductVariantTypeValue"
  },
  "Product_CreateVariant": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_CreateVariant",
    "requestElement": "Product_CreateVariant",
    "args": [
      { "name": "VariantData", "type": "tns:ProductVariantCreate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_CreateVariantResponse",
    "resultElement": "Product_CreateVariantResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new ProductVariant"
  },
  "Product_UpdateVariant": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_UpdateVariant",
    "requestElement": "Product_UpdateVariant",
    "args": [
      { "name": "VariantData", "type": "tns:ProductVariantUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_UpdateVariantResponse",
    "resultElement": "Product_UpdateVariantResult",
    "resultType": "tns:ArrayOfInt",
    "resultItemType": "xsd:int",
    "resultItemElement": "item",
    "documentation": "Updates a ProductVariant. Either Id or Itemnumber can be used as identifier. If Itemnumber is used, this call might update several variants in case they have the same Itemnumber."
  },
  "Product_CreateOrUpdateVariant": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_CreateOrUpdateVariant",
    "requestElement": "Product_CreateOrUpdateVariant",
    "args": [
      { "name": "VariantData", "type": "tns:ProductVariantCreateUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_CreateOrUpdateVariantResponse",
    "resultElement": "Product_CreateOrUpdateVariantResult",
    "resultType": "xsd:int",
    "documentation": "Creates or Updates a ProductVariant using its ItemNumber as key. Assumes that only unique ItemNumbers exist in the shop. If the Itemnumber supplied is not found a new ProductVariant is created"
  },
  "Product_Delete": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_Delete",
    "requestElement": "Product_Delete",
    "args": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_DeleteResponse",
    "resultElement": "Product_DeleteResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a Product"
  },
  "Product_DeleteVariant": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_DeleteVariant",
    "requestElement": "Product_DeleteVariant",
    "args": [
      { "name": "VariantId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_DeleteVariantResponse",
    "resultElement": "Product_DeleteVariantResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a ProductVariant"
  },
  "Product_GetDeliveryTime": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetDeliveryTime",
    "requestElement": "Product_GetDeliveryTime",
    "args": [
      { "name": "DeliveryTimeId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetDeliveryTimeResponse",
    "resultElement": "Product_GetDeliveryTimeResult",
    "resultType": "tns:ProductDeliveryTime",
    "documentation": "Returns the indicated ProductDeliveryTime"
  },
  "Product_GetDeliveryTimeAll": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetDeliveryTimeAll",
    "requestElement": "Product_GetDeliveryTimeAll",
    "args": [],
    "responseElement": "Product_GetDeliveryTimeAllResponse",
    "resultElement": "Product_GetDeliveryTimeAllResult",
    "resultType": "tns:ArrayOfProductdeliverytime",
    "resultItemType": "tns:ProductDeliveryTime",
    "resultItemElement": "item",
    "documentation": "Returns all ProductDeliveryTimes"
  },
  "Product_CreateDeliveryTime": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_CreateDeliveryTime",
    "requestElement": "Product_CreateDeliveryTime",
    "args": [
      { "name": "DeliveryTimeData", "type": "tns:ProductDeliveryTimeCreate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_CreateDeliveryTimeResponse",
    "resultElement": "Product_CreateDeliveryTimeResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new ProductDeliveryTime"
  },
  "Product_UpdateDeliveryTime": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_UpdateDeliveryTime",
    "requestElement": "Product_UpdateDeliveryTime",
    "args": [
      { "name": "DeliveryTimeData", "type": "tns:ProductDeliveryTimeUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_UpdateDeliveryTimeResponse",
    "resultElement": "Product_UpdateDeliveryTimeResult",
    "resultType": "xsd:int",
    "documentation": "Updates a ProductDeliveryTime"
  },
  "Product_DeleteDeliveryTime": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_DeleteDeliveryTime",
    "requestElement": "Product_DeleteDeliveryTime",
    "args": [
      { "name": "ProductDeliveryTimeId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_DeleteDeliveryTimeResponse",
    "resultElement": "Product_DeleteDeliveryTimeResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a ProductDeliveryTime"
  },
  "Product_GetDeliveryCountry": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetDeliveryCountry",
    "requestElement": "Product_GetDeliveryCountry",
    "args": [
      { "name": "DeliveryCountryId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetDeliveryCountryResponse",
    "resultElement": "Product_GetDeliveryCountryResult",
    "resultType": "tns:ProductDeliveryCountry",
    "documentation": "Returns the indicated ProductDeliveryCountry"
  },
  "Product_GetDeliveryCountryAll": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetDeliveryCountryAll",
    "requestElement": "Product_GetDeliveryCountryAll",
    "args": [],
    "responseElement": "Product_GetDeliveryCountryAllResponse",
    "resultElement": "Product_GetDeliveryCountryAllResult",
    "resultType": "tns:ArrayOfProductdeliverycountry",
    "resultItemType": "tns:ProductDeliveryCountry",
    "resultItemElement": "item",
    "documentation": "Returns all ProductDeliveryCountries"
  },
  "Product_CreateDeliveryCountry": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_CreateDeliveryCountry",
    "requestElement": "Product_CreateDeliveryCountry",
    "args": [
      { "name": "DeliveryCountryData", "type": "tns:ProductDeliveryCountryCreate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_CreateDeliveryCountryResponse",
    "resultElement": "Product_CreateDeliveryCountryResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new ProductDeliveryCountry"
  },
  "Product_UpdateDeliveryCountry": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_UpdateDeliveryCountry",
    "requestElement": "Product_UpdateDeliveryCountry",
    "args": [
      { "name": "DeliveryCountryData", "type": "tns:ProductDeliveryCountryUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_UpdateDeliveryCountryResponse",
    "resultElement": "Product_UpdateDeliveryCountryResult",
    "resultType": "xsd:int",
    "documentation": "Updates a ProductDeliveryCountry"
  },
  "Product_DeleteDeliveryCountry": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_DeleteDeliveryCountry",
    "requestElement": "Product_DeleteDeliveryCountry",
    "args": [
      { "name": "ProductDeliveryCountryId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_DeleteDeliveryCountryResponse",
    "resultElement": "Product_DeleteDeliveryCountryResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a ProductDeliveryCountry"
  },
  "Product_GetTags": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetTags",
    "requestElement": "Product_GetTags",
    "args": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetTagsResponse",
    "resultElement": "Product_GetTagsResult",
    "resultType": "tns:ArrayOfProducttag",
    "resultItemType": "tns:ProductTag",
    "resultItemElement": "item",
    "documentation": "Returns the ProductTags of the indicated Product"
  },
  "Product_GetPictures": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetPictures",
    "requestElement": "Product_GetPictures",
    "args": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetPicturesResponse",
    "resultElement": "Product_GetPicturesResult",
    "resultType": "tns:ArrayOfProductpicture",
    "resultItemType": "tns:ProductPicture",
    "resultItemElement": "item",
    "documentation": "Returns the ProductPictures of the indicated Product"
  },
  "Product_CreatePicture": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_CreatePicture",
    "requestElement": "Product_CreatePicture",
    "args": [
      { "name": "PictureData", "type": "tns:ProductPictureCreate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_CreatePictureResponse",
    "resultElement": "Product_CreatePictureResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new ProductPicture"
  },
  "Product_UpdatePicture": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_UpdatePicture",
    "requestElement": "Product_UpdatePicture",
    "args": [
      { "name": "PictureData", "type": "tns:ProductPictureUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_UpdatePictureResponse",
    "resultElement": "Product_UpdatePictureResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new ProductPicture"
  },
  "Product_DeletePicture": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_DeletePicture",
    "requestElement": "Product_DeletePicture",
    "args": [
      { "name": "PictureId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_DeletePictureResponse",
    "resultElement": "Product_DeletePictureResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a ProductPicture"
  },
  "Product_GetFiles": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetFiles",
    "requestElement": "Product_GetFiles",
    "args": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetFilesResponse",
    "resultElement": "Product_GetFilesResult",
    "resultType": "tns:ArrayOfProductfile",
    "resultItemType": "tns:ProductFile",
    "resultItemElement": "item",
    "documentation": "Returns the ProductFiles of the indicated Product"
  },
  "Product_CreateFile": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_CreateFile",
    "requestElement": "Product_CreateFile",
    "args": [
      { "name": "FileData", "type": "tns:ProductFileCreate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_CreateFileResponse",
    "resultElement": "Product_CreateFileResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new ProductFile"
  },
  "Product_UpdateFile": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_UpdateFile",
    "requestElement": "Product_UpdateFile",
    "args": [
      { "name": "FileData", "type": "tns:ProductFileUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Product_UpdateFileResponse",
    "resultElement": "Product_UpdateFileResult",
    "resultType": "xsd:int",
    "documentation": "Updates a ProductFile"
  },
  "Product_DeleteFile": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_DeleteFile",
    "requestElement": "Product_DeleteFile",
    "args": [
      { "name": "FileId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_DeleteFileResponse",
    "resultElement": "Product_DeleteFileResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a ProductFile"
  },
  "Product_GetSecondaryCategories": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_GetSecondaryCategories",
    "requestElement": "Product_GetSecondaryCategories",
    "args": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Product_GetSecondaryCategoriesResponse",
    "resultElement": "Product_GetSecondaryCategoriesResult",
    "resultType": "tns:ArrayOfCategory",
    "resultItemType": "tns:Category",
    "resultItemElement": "item",
    "documentation": "Returns the secondary Categories of the indicated Product"
  },
  "Page_GetPictures": {
    "soapAction": "https://api.hostedshop.io/service.php#Page_GetPictures",
    "requestElement": "Page_GetPictures",
    "args": [
      { "name": "PageId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Page_GetPicturesResponse",
    "resultElement": "Page_GetPicturesResult",
    "resultType": "tns:ArrayOfPagepicture",
    "resultItemType": "tns:PagePicture",
    "resultItemElement": "item",
    "documentation": "Returns the PagePictures of the indicated Page."
  },
  "Page_GetPictureThumbnails": {
    "soapAction": "https://api.hostedshop.io/service.php#Page_GetPictureThumbnails",
    "requestElement": "Page_GetPictureThumbnails",
    "args": [
      { "name": "PageId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ThumbWidth", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ThumbHeight", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Crop", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Greyscale", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Watermark", "type": "xsd:boolean", "nillable": false, "required": true }
    ],
    "responseElement": "Page_GetPictureThumbnailsResponse",
    "resultElement": "Page_GetPictureThumbnailsResult",
    "resultType": "tns:ArrayOfPagepicture",
    "resultItemType": "tns:PagePicture",
    "resultItemElement": "item",
    "documentation": "Returns the PagePictures of the indicated Page."
  },
  "PageText_SetFields": {
    "soapAction": "https://api.hostedshop.io/service.php#PageText_SetFields",
    "requestElement": "PageText_SetFields",
    "args": [
      { "name": "Fields", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "PageText_SetFieldsResponse",
    "resultElement": "PageText_SetFieldsResult",
    "resultType": "xsd:boolean",
    "documentation": "Sets the outputformat for all methods returning PageText Objects. If not set, the output format includes only the Id"
  },
  "PageText_GetById": {
    "soapAction": "https://api.hostedshop.io/service.php#PageText_GetById",
    "requestElement": "PageText_GetById",
    "args": [
      { "name": "PageTextId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "PageText_GetByIdResponse",
    "resultElement": "PageText_GetByIdResult",
    "resultType": "tns:PageText",
    "documentation": "Returns the indicated PageText. The output format can be set with PageText_SetFields"
  },
  "PageText_GetByIds": {
    "soapAction": "https://api.hostedshop.io/service.php#PageText_GetByIds",
    "requestElement": "PageText_GetByIds",
    "args": [
      { "name": "PageTextIds", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "PageText_GetByIdsResponse",
    "resultElement": "PageText_GetByIdsResult",
    "resultType": "tns:ArrayOfPagetext",
    "resultItemType": "tns:PageText",
    "resultItemElement": "item",
    "documentation": "Returns the indicated PageTexts. The output format can be set with PageText_SetFields"
  },
  "PageText_GetByFolder": {
    "soapAction": "https://api.hostedshop.io/service.php#PageText_GetByFolder",
    "requestElement": "PageText_GetByFolder",
    "args": [
      { "name": "FolderId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "PageText_GetByFolderResponse",
    "resultElement": "PageText_GetByFolderResult",
    "resultType": "tns:ArrayOfPagetext",
    "resultItemType": "tns:PageText",
    "resultItemElement": "item",
    "documentation": "Returns the PageTexts of the indicated folder. The output format can be set with PageText_SetFields"
  },
  "PageText_GetByLink": {
    "soapAction": "https://api.hostedshop.io/service.php#PageText_GetByLink",
    "requestElement": "PageText_GetByLink",
    "args": [
      { "name": "PageTextLink", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "PageText_GetByLinkResponse",
    "resultElement": "PageText_GetByLinkResult",
    "resultType": "tns:PageText",
    "documentation": "Returns the indicated PageText. The output format can be set with PageText_SetFields"
  },
  "PageText_Create": {
    "soapAction": "https://api.hostedshop.io/service.php#PageText_Create",
    "requestElement": "PageText_Create",
    "args": [
      { "name": "PageTextData", "type": "tns:PageTextCreate", "nillable": false, "required": true }
    ],
    "responseElement": "PageText_CreateResponse",
    "resultElement": "PageText_CreateResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new PageText."
  },
  "PageText_Update": {
    "soapAction": "https://api.hostedshop.io/service.php#PageText_Update",
    "requestElement": "PageText_Update",
    "args": [
      { "name": "PageTextData", "type": "tns:PageTextUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "PageText_UpdateResponse",
    "resultElement": "PageText_UpdateResult",
    "resultType": "xsd:int",
    "documentation": "Updates a PageText."
  },
  "PageText_SetThumbOptions": {
    "soapAction": "https://api.hostedshop.io/service.php#PageText_SetThumbOptions",
    "requestElement": "PageText_SetThumbOptions",
    "args": [
      { "name": "ThumbWidth", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ThumbHeight", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Crop", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Greyscale", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Watermark", "type": "xsd:boolean", "nillable": false, "required": true }
    ],
    "responseElement": "PageText_SetThumbOptionsResponse",
    "resultElement": "PageText_SetThumbOptionsResult",
    "resultType": "xsd:boolean",
    "documentation": "Sets the format for the thumbnails returned in PageText objects"
  },
  "PageText_Delete": {
    "soapAction": "https://api.hostedshop.io/service.php#PageText_Delete",
    "requestElement": "PageText_Delete",
    "args": [
      { "name": "PageTextId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "PageText_DeleteResponse",
    "resultElement": "PageText_DeleteResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a PageText"
  },
  "Delivery_GetAll": {
    "soapAction": "https://api.hostedshop.io/service.php#Delivery_GetAll",
    "requestElement": "Delivery_GetAll",
    "args": [],
    "responseElement": "Delivery_GetAllResponse",
    "resultElement": "Delivery_GetAllResult",
    "resultType": "tns:ArrayOfDelivery",
    "resultItemType": "tns:Delivery",
    "resultItemElement": "item",
    "documentation": "Returns all available Delivery Methods"
  },
  "Delivery_GetByLocation": {
    "soapAction": "https://api.hostedshop.io/service.php#Delivery_GetByLocation",
    "requestElement": "Delivery_GetByLocation",
    "args": [
      { "name": "Zip", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "CountryCode", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Weight", "type": "xsd:double", "nillable": false, "required": true }
    ],
    "responseElement": "Delivery_GetByLocationResponse",
    "resultElement": "Delivery_GetByLocationResult",
    "resultType": "tns:ArrayOfDelivery",
    "resultItemType": "tns:Delivery",
    "resultItemElement": "item",
    "documentation": "Returns Deliveries available in the supplied region"
  },
  "Delivery_UpdateDropPoint": {
    "soapAction": "https://api.hostedshop.io/service.php#Delivery_UpdateDropPoint",
    "requestElement": "Delivery_UpdateDropPoint",
    "args": [
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "DropPointId", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Delivery_UpdateDropPointResponse",
    "resultElement": "Delivery_UpdateDropPointResult",
    "resultType": "xsd:boolean",
    "documentation": "Updates the DropPointId of an OrderDelivery"
  },
  "Payment_GetAll": {
    "soapAction": "https://api.hostedshop.io/service.php#Payment_GetAll",
    "requestElement": "Payment_GetAll",
    "args": [],
    "responseElement": "Payment_GetAllResponse",
    "resultElement": "Payment_GetAllResult",
    "resultType": "tns:ArrayOfPaymentmethod",
    "resultItemType": "tns:PaymentMethod",
    "resultItemElement": "item",
    "documentation": "Returns all available PaymentMethods"
  },
  "Payment_GetByCountry": {
    "soapAction": "https://api.hostedshop.io/service.php#Payment_GetByCountry",
    "requestElement": "Payment_GetByCountry",
    "args": [
      { "name": "CountryCode", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Payment_GetByCountryResponse",
    "resultElement": "Payment_GetByCountryResult",
    "resultType": "tns:ArrayOfPaymentmethod",
    "resultItemType": "tns:PaymentMethod",
    "resultItemElement": "item",
    "documentation": "Returns the available PaymentMethods for the given country code"
  },
  "Product_Search": {
    "soapAction": "https://api.hostedshop.io/service.php#Product_Search",
    "requestElement": "Product_Search",
    "args": [
      { "name": "SearchString", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "Product_SearchResponse",
    "resultElement": "Product_SearchResult",
    "resultType": "tns:ArrayOfProduct",
    "resultItemType": "tns:Product",
    "resultItemElement": "item",
    "documentation": "Searches for products relevant for the given searchstring"
  },
  "Discount_GetById": {
    "soapAction": "https://api.hostedshop.io/service.php#Discount_GetById",
    "requestElement": "Discount_GetById",
    "args": [
      { "name": "DiscountId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Discount_GetByIdResponse",
    "resultElement": "Discount_GetByIdResult",
    "resultType": "tns:Discount",
    "documentation": "Returns the indicated Discount."
  },
  "Discount_GetAll": {
    "soapAction": "https://api.hostedshop.io/service.php#Discount_GetAll",
    "requestElement": "Discount_GetAll",
    "args": [],
    "responseElement": "Discount_GetAllResponse",
    "resultElement": "Discount_GetAllResult",
    "resultType": "tns:ArrayOfDiscount",
    "resultItemType": "tns:Discount",
    "resultItemElement": "item",
    "documentation": "Returns all Discounts."
  },
  "Discount_Create": {
    "soapAction": "https://api.hostedshop.io/service.php#Discount_Create",
    "requestElement": "Discount_Create",
    "args": [
      { "name": "DiscountData", "type": "tns:DiscountCreate", "nillable": false, "required": true }
    ],
    "responseElement": "Discount_CreateResponse",
    "resultElement": "Discount_CreateResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new Discount"
  },
  "Discount_Update": {
    "soapAction": "https://api.hostedshop.io/service.php#Discount_Update",
    "requestElement": "Discount_Update",
    "args": [
      { "name": "DiscountData", "type": "tns:DiscountUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Discount_UpdateResponse",
    "resultElement": "Discount_UpdateResult",
    "resultType": "xsd:int",
    "documentation": "Updates a Discount"
  },
  "Discount_Delete": {
    "soapAction": "https://api.hostedshop.io/service.php#Discount_Delete",
    "requestElement": "Discount_Delete",
    "args": [
      { "name": "DiscountId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Discount_DeleteResponse",
    "resultElement": "Discount_DeleteResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a Discount"
  },
  "SEORedirect_GetById": {
    "soapAction": "https://api.hostedshop.io/service.php#SEORedirect_GetById",
    "requestElement": "SEORedirect_GetById",
    "args": [
      { "name": "SEORedirectId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "SEORedirect_GetByIdResponse",
    "resultElement": "SEORedirect_GetByIdResult",
    "resultType": "tns:SEORedirect",
    "documentation": "Returns the indicated SEORedirect."
  },
  "SEORedirect_GetAll": {
    "soapAction": "https://api.hostedshop.io/service.php#SEORedirect_GetAll",
    "requestElement": "SEORedirect_GetAll",
    "args": [],
    "responseElement": "SEORedirect_GetAllResponse",
    "resultElement": "SEORedirect_GetAllResult",
    "resultType": "tns:ArrayOfSeoredirect",
    "resultItemType": "tns:SEORedirect",
    "resultItemElement": "item",
    "documentation": "Returns all SEORedirects."
  },
  "SEORedirect_Delete": {
    "soapAction": "https://api.hostedshop.io/service.php#SEORedirect_Delete",
    "requestElement": "SEORedirect_Delete",
    "args": [
      { "name": "SEORedirectId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "SEORedirect_DeleteResponse",
    "resultElement": "SEORedirect_DeleteResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a SEORedirect"
  },
  "Solution_CreateCustomData": {
    "soapAction": "https://api.hostedshop.io/service.php#Solution_CreateCustomData",
    "requestElement": "Solution_CreateCustomData",
    "args": [
      { "name": "CustomData", "type": "tns:CustomDataCreate", "nillable": false, "required": true }
    ],
    "responseElement": "Solution_CreateCustomDataResponse",
    "resultElement": "Solution_CreateCustomDataResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new CustomData"
  },
  "Solution_UpdateCustomData": {
    "soapAction": "https://api.hostedshop.io/service.php#Solution_UpdateCustomData",
    "requestElement": "Solution_UpdateCustomData",
    "args": [
      { "name": "CustomData", "type": "tns:CustomDataUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "Solution_UpdateCustomDataResponse",
    "resultElement": "Solution_UpdateCustomDataResult",
    "resultType": "xsd:int",
    "documentation": "Upates a CustomData"
  },
  "Solution_DeleteCustomData": {
    "soapAction": "https://api.hostedshop.io/service.php#Solution_DeleteCustomData",
    "requestElement": "Solution_DeleteCustomData",
    "args": [
      { "name": "CustomDataId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Solution_DeleteCustomDataResponse",
    "resultElement": "Solution_DeleteCustomDataResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a CustomData"
  },
  "Solution_GetCustomDataTypeAll": {
    "soapAction": "https://api.hostedshop.io/service.php#Solution_GetCustomDataTypeAll",
    "requestElement": "Solution_GetCustomDataTypeAll",
    "args": [
      { "name": "Entity", "type": "xsd:anyType", "nillable": false, "required": true }
    ],
    "responseElement": "Solution_GetCustomDataTypeAllResponse",
    "resultElement": "Solution_GetCustomDataTypeAllResult",
    "resultType": "tns:ArrayOfCustomdatatype",
    "resultItemType": "tns:CustomDataType",
    "resultItemElement": "item",
    "documentation": "Returns all CustomDataType of a certain Entity type"
  },
  "User_AddCustomDataBind": {
    "soapAction": "https://api.hostedshop.io/service.php#User_AddCustomDataBind",
    "requestElement": "User_AddCustomDataBind",
    "args": [
      { "name": "UserId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "CustomDataId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "User_AddCustomDataBindResponse",
    "resultElement": "User_AddCustomDataBindResult",
    "resultType": "xsd:boolean",
    "documentation": "Adds an existing CostumData to the indicated User"
  },
  "User_RemoveCustomDataBind": {
    "soapAction": "https://api.hostedshop.io/service.php#User_RemoveCustomDataBind",
    "requestElement": "User_RemoveCustomDataBind",
    "args": [
      { "name": "UserId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "CustomDataId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "User_RemoveCustomDataBindResponse",
    "resultElement": "User_RemoveCustomDataBindResult",
    "resultType": "xsd:boolean",
    "documentation": "Removes a CostumData from the indicated User"
  },
  "User_UpdateCustomDataTextBind": {
    "soapAction": "https://api.hostedshop.io/service.php#User_UpdateCustomDataTextBind",
    "requestElement": "User_UpdateCustomDataTextBind",
    "args": [
      { "name": "UserId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "CustomDataTypeId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Text", "type": "xsd:string", "nillable": false, "required": true }
    ],
    "responseElement": "User_UpdateCustomDataTextBindResponse",
    "resultElement": "User_UpdateCustomDataTextBindResult",
    "resultType": "xsd:boolean",
    "documentation": "Updates the text of a 'textype' CostumData for the indicated User"
  },
  "Sites_GetById": {
    "soapAction": "https://api.hostedshop.io/service.php#Sites_GetById",
    "requestElement": "Sites_GetById",
    "args": [
      { "name": "SiteId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Sites_GetByIdResponse",
    "resultElement": "Sites_GetByIdResult",
    "resultType": "tns:Site",
    "documentation": "Returns the indicated Site"
  },
  "Sites_GetAll": {
    "soapAction": "https://api.hostedshop.io/service.php#Sites_GetAll",
    "requestElement": "Sites_GetAll",
    "args": [],
    "responseElement": "Sites_GetAllResponse",
    "resultElement": "Sites_GetAllResult",
    "resultType": "tns:ArrayOfSite",
    "resultItemType": "tns:Site",
    "resultItemElement": "item",
    "documentation": "Returns the Sites of the solution"
  },
  "VatGroup_GetAll": {
    "soapAction": "https://api.hostedshop.io/service.php#VatGroup_GetAll",
    "requestElement": "VatGroup_GetAll",
    "args": [],
    "responseElement": "VatGroup_GetAllResponse",
    "resultElement": "VatGroup_GetAllResult",
    "resultType": "tns:ArrayOfVatgroup",
    "resultItemType": "tns:VatGroup",
    "resultItemElement": "item",
    "documentation": "Returns the VatGroups of the solution"
  },
  "VatGroup_GetById": {
    "soapAction": "https://api.hostedshop.io/service.php#VatGroup_GetById",
    "requestElement": "VatGroup_GetById",
    "args": [
      { "name": "VatGroupId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "VatGroup_GetByIdResponse",
    "resultElement": "VatGroup_GetByIdResult",
    "resultType": "tns:VatGroup",
    "documentation": "Returns the indicated VatGroup"
  },
  "VatGroup_Create": {
    "soapAction": "https://api.hostedshop.io/service.php#VatGroup_Create",
    "requestElement": "VatGroup_Create",
    "args": [
      { "name": "VatGroupData", "type": "tns:VatGroupCreate", "nillable": false, "required": true }
    ],
    "responseElement": "VatGroup_CreateResponse",
    "resultElement": "VatGroup_CreateResult",
    "resultType": "xsd:int",
    "documentation": "Creates a new VatGroup"
  },
  "VatGroup_Update": {
    "soapAction": "https://api.hostedshop.io/service.php#VatGroup_Update",
    "requestElement": "VatGroup_Update",
    "args": [
      { "name": "VatGroupData", "type": "tns:VatGroupUpdate", "nillable": false, "required": true }
    ],
    "responseElement": "VatGroup_UpdateResponse",
    "resultElement": "VatGroup_UpdateResult",
    "resultType": "xsd:int",
    "documentation": "Updates a User"
  },
  "VatGroup_Delete": {
    "soapAction": "https://api.hostedshop.io/service.php#VatGroup_Delete",
    "requestElement": "VatGroup_Delete",
    "args": [
      { "name": "VatGroupId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "VatGroup_DeleteResponse",
    "resultElement": "VatGroup_DeleteResult",
    "resultType": "xsd:boolean",
    "documentation": "Deletes a VatGroup"
  },
  "Order_SendMail": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_SendMail",
    "requestElement": "Order_SendMail",
    "args": [
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "TypeId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_SendMailResponse",
    "resultElement": "Order_SendMailResult",
    "resultType": "xsd:boolean",
    "documentation": "Sends a mail for an Order"
  },
  "Order_SendStatusEmail": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_SendStatusEmail",
    "requestElement": "Order_SendStatusEmail",
    "args": [
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_SendStatusEmailResponse",
    "resultElement": "Order_SendStatusEmailResult",
    "resultType": "xsd:boolean",
    "documentation": "Sends a status e-mail for an Order for its current order status"
  },
  "Order_SendInvoiceEmail": {
    "soapAction": "https://api.hostedshop.io/service.php#Order_SendInvoiceEmail",
    "requestElement": "Order_SendInvoiceEmail",
    "args": [
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true }
    ],
    "responseElement": "Order_SendInvoiceEmailResponse",
    "resultElement": "Order_SendInvoiceEmailResult",
    "resultType": "xsd:boolean",
    "documentation": "Sends an invoice e-mail for an Order"
  }
};

// R4: complexType -> exact field list. Validate every *_SetFields list against this
// BEFORE sending; one bad name faults the call and leaves the session on its previous
// field set, which then reads a smaller record with no error at all.
export const TYPES = {
  "ShopWebinfo": [
    "Title", "LanguageISO", "Company", "ContactPerson", "Address", "Zip", "City", "Country",
    "Phone", "Mobile", "Fax", "Email", "EmailDummy", "Cvr", "BankInfo", "ProductPricesWithVat",
    "ShowProductPricesWithVat", "SolutionId"
  ],
  "ArrayOfString": ["item"],
  "SolutionLanguage": ["Id", "LanguageISO", "Title", "Primary", "Status", "SiteId"],
  "ArrayOfSolutionlanguage": ["item"],
  "User": [
    "Id", "Username", "Password", "UserGroupId", "Type", "Company", "CustomData", "Cvr", "Ean",
    "Firstname", "Lastname", "Sex", "Address", "Address2", "Zip", "City", "Country", "CountryCode",
    "Currency", "Phone", "Mobile", "Fax", "Email", "Url", "DiscountGroupId", "Newsletter",
    "Referer", "BirthDate", "DateCreated", "DateUpdated", "Approved", "LanguageISO",
    "LanguageAccess", "Description", "InterestFields", "Number", "Site", "ShippingType",
    "ShippingFirstname", "ShippingLastname", "ShippingCompany", "ShippingCvr", "ShippingEan",
    "ShippingAddress", "ShippingAddress2", "ShippingZip", "ShippingCity", "ShippingCountry",
    "ShippingCountryCode", "ShippingState", "ShippingPhone", "ShippingMobile", "ShippingEmail",
    "ShippingReferenceNumber", "Consent", "ConsentDate"
  ],
  "ArrayOfUser": ["item"],
  "UserCreate": [
    "Username", "Password", "UserGroupId", "Type", "Company", "Cvr", "Ean", "Firstname", "Lastname",
    "Sex", "Address", "Address2", "Zip", "City", "Country", "CountryCode", "Currency", "Phone",
    "Mobile", "Fax", "Email", "Url", "DiscountGroupId", "Newsletter", "Referer", "BirthDate",
    "DateCreated", "DateUpdated", "Approved", "LanguageISO", "Site", "LanguageAccess",
    "Description", "InterestFields", "Number", "SeoDescription", "SeoTitle", "ShippingType",
    "ShippingFirstname", "ShippingLastname", "ShippingCompany", "ShippingCvr", "ShippingEan",
    "ShippingAddress", "ShippingAddress2", "ShippingZip", "ShippingCity", "ShippingCountry",
    "ShippingCountryCode", "ShippingState", "ShippingPhone", "ShippingEmail",
    "ShippingReferenceNumber", "Consent", "ConsentDate"
  ],
  "UserUpdate": [
    "Id", "Username", "Password", "UserGroupId", "Type", "Company", "Cvr", "Ean", "Firstname",
    "Lastname", "Sex", "Address", "Address2", "Zip", "City", "Country", "CountryCode", "Currency",
    "Phone", "Mobile", "Fax", "Email", "Url", "DiscountGroupId", "Newsletter", "Referer",
    "BirthDate", "DateCreated", "DateUpdated", "Approved", "LanguageISO", "Site", "LanguageAccess",
    "Description", "InterestFields", "Number", "SeoDescription", "SeoTitle", "ShippingType",
    "ShippingFirstname", "ShippingLastname", "ShippingCompany", "ShippingCvr", "ShippingEan",
    "ShippingAddress", "ShippingAddress2", "ShippingZip", "ShippingCity", "ShippingCountry",
    "ShippingCountryCode", "ShippingState", "ShippingPhone", "ShippingMobile", "ShippingEmail",
    "ShippingReferenceNumber", "Consent", "ConsentDate"
  ],
  "UserCreateUpdate": [
    "Username", "Password", "UserGroupId", "Type", "Company", "Cvr", "Ean", "Firstname", "Lastname",
    "Sex", "Address", "Address2", "Zip", "City", "Country", "CountryCode", "Currency", "Phone",
    "Mobile", "Fax", "Email", "Url", "DiscountGroupId", "Newsletter", "Referer", "BirthDate",
    "DateCreated", "DateUpdated", "Approved", "LanguageISO", "Site", "LanguageAccess",
    "Description", "InterestFields", "Number", "SeoDescription", "SeoTitle", "ShippingType",
    "ShippingFirstname", "ShippingLastname", "ShippingCompany", "ShippingCvr", "ShippingEan",
    "ShippingAddress", "ShippingAddress2", "ShippingZip", "ShippingCity", "ShippingCountry",
    "ShippingCountryCode", "ShippingState", "ShippingPhone", "ShippingMobile", "ShippingEmail",
    "ShippingReferenceNumber", "Consent", "ConsentDate"
  ],
  "UserGroup": [
    "Description", "Id", "InterestFields", "ParentId", "Producer", "LanguageISO", "Title", "Sorting"
  ],
  "ArrayOfUsergroup": ["item"],
  "UserGroupCreate": ["Description", "ParentId", "Producer", "LanguageISO", "Title", "Sorting"],
  "UserGroupUpdate": ["Description", "Id", "ParentId", "Producer", "LanguageISO", "Title", "Sorting"],
  "NewsletterCustomField": ["Id", "Name", "Type", "Default", "UserGroupId", "ServiceId"],
  "ArrayOfNewslettercustomfield": ["item"],
  "Category": [
    "Id", "Description", "DescriptionBottom", "LanguageISO", "SeoDescripton", "SeoKeywords",
    "SeoTitle", "SeoLink", "SeoCanonical", "Title", "ParentId", "Status", "Sorting",
    "LanguageAccess", "UserGroupAccessIds", "ShowInMenu"
  ],
  "ArrayOfCategory": ["item"],
  "CategoryCreate": [
    "Description", "DescriptionBottom", "LanguageISO", "Title", "SeoTitle", "SeoDescription",
    "SeoKeywords", "SeoLink", "SeoCanonical", "ParentId", "Status", "Sorting", "LanguageAccess",
    "UserGroupAccessIds", "ShowInMenu"
  ],
  "CategoryUpdate": [
    "Id", "Description", "DescriptionBottom", "ParentId", "LanguageISO", "Title", "SeoTitle",
    "SeoDescription", "SeoKeywords", "SeoLink", "SeoCanonical", "Status", "Sorting",
    "LanguageAccess", "UserGroupAccessIds", "ShowInMenu"
  ],
  "CategoryCreateUpdate": [
    "LanguageISO", "Title", "Description", "DescriptionBottom", "SeoTitle", "SeoDescription",
    "SeoKeywords", "SeoLink", "SeoCanonical", "ParentId", "Status", "Sorting", "LanguageAccess",
    "UserGroupAccessIds", "ShowInMenu"
  ],
  "CategoryPicture": ["Id", "CategoryId", "Name", "Sorting", "ImageAltTexts"],
  "ArrayOfCategorypicture": ["item"],
  "CategoryPictureCreate": ["CategoryId", "Name", "Sorting", "ImageAltTexts"],
  "CategoryPictureUpdate": ["Id", "CategoryId", "Name", "Sorting", "ImageAltTexts"],
  "ProductDiscount": [
    "Id", "ProductId", "ProductVariantId", "Amount", "Price", "Discount", "Currency",
    "DiscountType", "UserType", "UserId", "Date", "DateFrom", "DateTo", "Accumulate", "Site",
    "Language"
  ],
  "ArrayOfProductdiscount": ["item"],
  "ProductDiscountCreate": [
    "ProductId", "ProductVariantId", "Amount", "Price", "Discount", "Currency", "DiscountType",
    "UserType", "UserId", "Date", "DateFrom", "DateTo", "Accumulate", "Site", "Language"
  ],
  "ProductDiscountUpdate": [
    "Id", "ProductId", "ProductVariantId", "Amount", "Price", "Discount", "Currency",
    "DiscountType", "UserType", "UserId", "Date", "DateFrom", "DateTo", "Accumulate", "Site",
    "Language"
  ],
  "ProductDiscountAccumulative": [
    "Id", "Type1", "Type1Id", "Type2", "Type2Id", "Amount", "Discount", "Currency", "Date",
    "DateFrom", "DateTo", "Site", "Language"
  ],
  "ArrayOfProductdiscountaccumulative": ["item"],
  "ProductDiscountAccumulativeCreate": [
    "Type1", "Type1Id", "Type2", "Type2Id", "Amount", "Discount", "Currency", "Date", "DateFrom",
    "DateTo", "Site", "Language"
  ],
  "ProductDiscountAccumulativeUpdate": [
    "Id", "Type1", "Type1Id", "Type2", "Type2Id", "Amount", "Discount", "Currency", "Date",
    "DateFrom", "DateTo", "Site", "Language"
  ],
  "ProductUnit": ["Id", "LanguageISO", "Title"],
  "ArrayOfProductunit": ["item"],
  "ProductUnitCreate": ["LanguageISO", "Title"],
  "ProductUnitUpdate": ["Id", "LanguageISO", "Title"],
  "Currency": [
    "Id", "Iso", "Symbol", "SymbolPlace", "Currency", "Decimal", "DecimalCount", "Point", "Round",
    "RoundOn", "Title"
  ],
  "ArrayOfCurrency": ["item"],
  "CurrencyCreate": [
    "Iso", "Symbol", "SymbolPlace", "Currency", "Decimal", "DecimalCount", "Point", "Round", "Title"
  ],
  "CurrencyUpdate": [
    "Id", "Iso", "Symbol", "SymbolPlace", "Currency", "Decimal", "DecimalCount", "Point", "Round",
    "Title"
  ],
  "OrderCurrency": ["OrderId", "Id", "Iso", "Symbol", "SymbolPlace", "Currency", "Decimal", "Point", "Round"],
  "OrderCustomer": [
    "Id", "OrderId", "Firstname", "Lastname", "Company", "B2B", "Cvr", "Ean", "Address", "Address2",
    "Zip", "City", "Country", "CountryCode", "State", "Phone", "Mobile", "Email",
    "ShippingFirstname", "ShippingLastname", "ShippingCompany", "ShippingAddress",
    "ShippingAddress2", "ShippingZip", "ShippingCity", "ShippingCountry", "ShippingCountryCode",
    "ShippingState", "ShippingPhone", "ShippingMobile", "ShippingEmail"
  ],
  "OrderPayment": ["Id", "OrderId", "PaymentMethodId", "Title", "Price", "Vat", "ExternalId"],
  "OrderTransaction": [
    "Id", "OrderId", "PaymentId", "Status", "TransactionNumber", "TransactionNumberLong",
    "SubscriptionId", "SubscriptionIdLong", "Cardtype", "Amount", "AmountFull", "AmountOriginal",
    "Currency", "Errorcode", "Actioncode", "Date"
  ],
  "ArrayOfOrdertransaction": ["item"],
  "OrderLineAddress": [
    "Id", "LineId", "Amount", "Firstname", "Lastname", "Company", "Address", "Zip", "City",
    "CountryIso", "Comment", "DeliveryDate", "DeliveryTime"
  ],
  "ArrayOfOrderlineaddress": ["item"],
  "OrderLine": [
    "Id", "OrderId", "ProductId", "VariantId", "FileDownloadId", "Amount", "PacketLines",
    "PacketTitle", "PacketId", "ProductTitle", "VariantTitle", "AdditionalTitle", "ItemNumber",
    "ItemNumberSupplier", "Discount", "DiscountRounded", "Price", "PriceRounded", "ServiceType",
    "BuyPrice", "StockStatus", "Status", "TrackingCode", "Weight", "LineAddresses",
    "OfflineProduct", "VatRate", "StockLocationId", "DeliveryId", "Unit", "ExtendedDataInternal",
    "ExtendedDataExternal"
  ],
  "ArrayOfOrderline": ["item"],
  "OrderPacking": ["Id", "OrderId", "Text", "From"],
  "OrderDelivery": [
    "Id", "OrderId", "DeliveryMethodId", "Vat", "Title", "Price", "BuyPrice", "ServiceType",
    "DroppointId", "DroppointIdLong"
  ],
  "OrderDiscountCode": [
    "Id", "OrderId", "DiscountId", "Title", "Type", "Value", "Discount", "Vat", "IsNewGiftCard"
  ],
  "ArrayOfOrderdiscountcode": ["item"],
  "Order": [
    "Id", "InvoiceNumber", "CurrencyId", "Currency", "CustomerId", "Customer", "UserId", "User",
    "Site", "LanguageISO", "Status", "PaymentId", "Payment", "Transactions", "Vat", "Total",
    "OrderComment", "OrderCommentExternal", "CustomerComment", "DeliveryComment", "DeliveryTime",
    "TrackingCode", "DateDelivered", "DateDue", "DateSent", "DateUpdated", "OrderLines",
    "PackingId", "Packing", "DeliveryId", "Delivery", "DiscountCodes", "ReferenceNumber", "Origin",
    "ReferralCode"
  ],
  "ArrayOfOrder": ["item"],
  "OrderLineCreate": [
    "ProductId", "VariantId", "FileDownloadId", "ServiceType", "TrackingCode", "Status", "Amount",
    "Discount", "Price", "BuyPrice", "Unit", "ExtendedDataInternal", "ExtendedDataExternal", "Vat"
  ],
  "ArrayOfOrderlinecreate": ["item"],
  "OrderCustomerCreate": [
    "OrderId", "Firstname", "Lastname", "Company", "Cvr", "B2B", "Ean", "Address", "Address2",
    "Zip", "City", "Country", "CountryCode", "State", "Phone", "Mobile", "Email",
    "ShippingFirstname", "ShippingLastname", "ShippingCompany", "ShippingAddress",
    "ShippingAddress2", "ShippingZip", "ShippingCity", "ShippingCountry", "ShippingCountryCode",
    "ShippingState", "ShippingPhone", "ShippingMobile", "ShippingEmail"
  ],
  "OrderTransactionCreate": [
    "OrderId", "PaymentId", "Status", "TransactionNumber", "TransactionNumberLong",
    "SubscriptionId", "SubscriptionIdLong", "Cardtype", "Amount", "Currency", "Errorcode",
    "Actioncode", "Date"
  ],
  "OrderCreate": [
    "CurrencyId", "SiteId", "LanguageISO", "UserId", "PaymentId", "PaymentOnlineId",
    "CustomerComment", "DeliveryId", "DeliveryComment", "DeliveryPrice", "DeliveryTime",
    "ReferenceNumber", "OrderLines", "OrderCustomer", "OrderTransaction", "Origin", "Delivery",
    "Vat", "ReferralCode"
  ],
  "OrderFileDownload": ["Id", "ProductId", "OrderId", "Count", "DateFrom", "DateTo"],
  "OrderStatusCode": ["Id", "Title", "LanguageISO", "Sorting"],
  "ArrayOfOrderStatusCode": ["item"],
  "OrderSetTransactionCode": [
    "OrderId", "PaymentId", "Status", "TransactionNumber", "TransactionNumberLong",
    "SubscriptionId", "Cardtype", "Amount", "Currency", "Errorcode", "Actioncode", "Date"
  ],
  "ArrayOfInt": ["item"],
  "DiscountGroup": ["Id", "Title", "Type", "Discount"],
  "ProductVariant": [
    "Id", "ProductId", "Stock", "StockLow", "Price", "BuyingPrice", "ItemNumber",
    "ItemNumberSupplier", "Weight", "DeliveryTime", "DeliveryTimeId", "Description",
    "DescriptionLong", "Status", "DisableOnEmpty", "Discount", "DiscountType", "Ean", "PictureId",
    "PictureIds", "Sorting", "VariantTypeValues", "MinAmount", "Title", "Unit", "StockLocations"
  ],
  "ArrayOfProductvariant": ["item"],
  "ProductTag": [
    "Id", "LanguageISO", "Title", "UserId", "Username", "UserEmail", "Rating", "Text", "DateCreated"
  ],
  "ArrayOfProducttag": ["item"],
  "ProductPicture": ["Id", "ProductId", "FileName", "Sorting", "ImageAltTexts"],
  "ArrayOfProductpicture": ["item"],
  "ProductFile": ["Id", "ProductId", "FileName", "Sorting"],
  "ArrayOfProductfile": ["item"],
  "ProductCustomData": [
    "Id", "ProductCustomId", "ProductCustomIds", "ProductCustomTypeId", "LanguageISO", "Title",
    "Sorting"
  ],
  "ArrayOfProductcustomdata": ["item"],
  "ProductAdditionalType": ["Id", "CategoryId", "LanguageISO", "Title"],
  "ArrayOfProductadditionaltype": ["item"],
  "ProductExtraBuyRelation": ["Id", "ProductId", "RelationProductId", "ExtraBuyCategoryId", "Sorting"],
  "ArrayOfProductextrabuyrelation": ["item"],
  "PacketProductLine": ["Id", "Amount", "Product", "VariantIds", "Sorting"],
  "ArrayOfPacketproductline": ["item"],
  "VatGroup": ["Id", "Name", "VatPercentage", "Sorting"],
  "Product": [
    "Id", "CategoryId", "Category", "SecondaryCategoryIds", "SecondaryCategories", "ProducerId",
    "Producer", "Online", "Status", "DisableOnEmpty", "CallForPrice", "Stock", "ItemNumber",
    "ItemNumberSupplier", "RelationCode", "Url", "Weight", "BuyingPrice", "Price", "Discount",
    "DiscountType", "Delivery", "DeliveryId", "DeliveryTime", "DeliveryTimeId", "DiscountGroupId",
    "DiscountGroup", "Ean", "FocusFrontpage", "FocusCart", "DateCreated", "DateUpdated",
    "RelatedProductIds", "LanguageISO", "Title", "SeoTitle", "SeoDescription", "SeoKeywords",
    "SeoLink", "SeoCanonical", "Description", "DescriptionShort", "DescriptionLong", "Variants",
    "Tags", "Pictures", "CustomData", "Additionals", "ExtraBuyRelations", "UnitId", "Unit",
    "UserAccess", "UserAccessIds", "UserGroupAccess", "UserGroupAccessIds", "Discounts",
    "MinAmount", "VariantTypes", "Sorting", "GuidelinePrice", "ProductUrl", "Type",
    "PacketProducts", "LanguageAccess", "VatGroupId", "VatGroup", "AutoStock", "CategorySortings",
    "OutOfStockBuy", "StockLow", "StockLocations", "TypeLabel"
  ],
  "ArrayOfProduct": ["item"],
  "ProductCreate": [
    "CategoryId", "SecondaryCategoryIds", "ProducerId", "Online", "Status", "DisableOnEmpty", "Ean",
    "CallForPrice", "Stock", "ItemNumber", "ItemNumberSupplier", "Url", "RelationCode", "Weight",
    "BuyingPrice", "Price", "Discount", "DiscountType", "DeliveryId", "DeliveryTimeId",
    "DiscountGroupId", "FocusFrontpage", "FocusCart", "DateCreated", "DateUpdated",
    "RelatedProducts", "LanguageISO", "Title", "SeoTitle", "SeoDescription", "SeoKeywords",
    "SeoLink", "SeoCanonical", "Description", "DescriptionShort", "DescriptionLong", "UnitId",
    "UserAccessIds", "UserGroupAccessIds", "MinAmount", "Sorting", "GuidelinePrice",
    "LanguageAccess", "VatGroupId", "AutoStock", "CategorySortings", "OutOfStockBuy", "StockLow",
    "TypeLabel"
  ],
  "ProductUpdate": [
    "Id", "CategoryId", "SecondaryCategoryIds", "ProducerId", "Online", "Status", "DisableOnEmpty",
    "Ean", "CallForPrice", "Stock", "ItemNumber", "ItemNumberSupplier", "Url", "Weight",
    "BuyingPrice", "Price", "Discount", "DiscountType", "DeliveryId", "DeliveryTimeId",
    "DiscountGroupId", "FocusFrontpage", "FocusCart", "DateCreated", "DateUpdated",
    "RelatedProducts", "LanguageISO", "Title", "SeoTitle", "SeoDescription", "SeoKeywords",
    "SeoLink", "SeoCanonical", "Description", "DescriptionShort", "DescriptionLong", "UnitId",
    "UserAccessIds", "UserGroupAccessIds", "MinAmount", "Sorting", "GuidelinePrice",
    "LanguageAccess", "VatGroupId", "AutoStock", "CategorySortings", "OutOfStockBuy", "StockLow",
    "TypeLabel"
  ],
  "ProductCreateUpdate": [
    "CategoryId", "SecondaryCategoryIds", "ProducerId", "Online", "Status", "DisableOnEmpty", "Ean",
    "CallForPrice", "Stock", "ItemNumber", "ItemNumberSupplier", "Url", "RelationCode", "Weight",
    "BuyingPrice", "Price", "Discount", "DiscountType", "DeliveryId", "DeliveryTimeId",
    "DiscountGroupId", "FocusFrontpage", "FocusCart", "DateCreated", "DateUpdated",
    "RelatedProducts", "LanguageISO", "Title", "SeoTitle", "SeoDescription", "SeoKeywords",
    "SeoLink", "SeoCanonical", "Description", "DescriptionShort", "DescriptionLong", "UnitId",
    "UserAccessIds", "UserGroupAccessIds", "MinAmount", "Sorting", "GuidelinePrice",
    "LanguageAccess", "VatGroupId", "AutoStock", "CategorySortings", "OutOfStockBuy", "StockLow",
    "TypeLabel"
  ],
  "ProductCreateOrUpdateBulkResult": ["Id", "Error"],
  "ArrayOfProductCreateUpdate": ["item"],
  "ArrayOfProductCreateOrUpdateBulkResult": ["item"],
  "ProductCategorySorting": ["CategoryId", "Sorting"],
  "ProductStockLocation": ["StockLocationId", "DeliveryTimeId", "Stock", "BuyPrice"],
  "ProductVariantStockLocation": ["StockLocationId", "DeliveryTimeId", "Stock", "BuyPrice"],
  "ArrayOfProductCategorySorting": ["item"],
  "ArrayOfProductStockLocation": ["item"],
  "ArrayOfProductVariantStockLocation": ["item"],
  "ProductAdditional": ["Id", "ProductAdditionalTypeId", "Price", "LanguageISO", "Title", "Sorting"],
  "ArrayOfProductadditional": ["item"],
  "ProductCustomDataCreate": ["ProductCustomId", "ProductCustomTypeId", "LanguageISO", "Title", "Sorting"],
  "ProductCustomDataUpdate": [
    "Id", "ProductCustomId", "ProductCustomTypeId", "LanguageISO", "Title", "Sorting"
  ],
  "ProductCustomDataTypeCreate": ["Sorting", "LanguageISO", "Title", "Display", "Type"],
  "ProductCustomDataTypeUpdate": ["Id", "Sorting", "LanguageISO", "Title", "Display", "Type"],
  "ProductCustomDataType": ["Id", "CategoryId", "Sorting", "LanguageISO", "Title", "Display", "Type"],
  "ArrayOfProductcustomdatatype": ["item"],
  "ArrayOfDiscountgroup": ["item"],
  "DiscountGroupCreate": ["Title", "Type", "Discount"],
  "DiscountGroupUpdate": ["Id", "Title", "Type", "Discount"],
  "DiscountGroupProduct": ["Id", "Title"],
  "ArrayOfDiscountgroupproduct": ["item"],
  "DiscountGroupProductCreate": ["Title"],
  "DiscountGroupProductUpdate": ["Id", "Title"],
  "ProductExtraBuyRelationCreate": ["ProductId", "RelationProductId", "ExtraBuyCategoryId", "Sorting"],
  "ProductExtraBuyRelationUpdate": ["Id", "ProductId", "RelationProductId", "ExtraBuyCategoryId", "Sorting"],
  "ProductExtraBuyCategory": ["Id", "LanguageISO", "Title", "ParentId", "Sorting"],
  "ArrayOfProductextrabuycategory": ["item"],
  "ProductExtraBuyCategoryCreate": ["LanguageISO", "Title", "ParentId", "Sorting"],
  "ProductExtraBuyCategoryUpdate": ["Id", "LanguageISO", "Title", "ParentId", "Sorting"],
  "ProductVariantTypeCreateUpdate": ["LanguageISO", "Title", "Sorting"],
  "ProductVariantTypeUpdate": ["Id", "LanguageISO", "Title", "Sorting"],
  "ArrayOfProductvarianttype": ["item"],
  "ProductVariantType": ["Id", "LanguageISO", "Title", "Sorting"],
  "ProductVariantTypeValueCreateUpdate": ["LanguageISO", "Title", "ProductVariantTypeId", "Sorting"],
  "ProductVariantTypeValueUpdate": ["Id", "LanguageISO", "Title", "ProductVariantTypeId", "Sorting"],
  "ProductVariantTypeValue": [
    "Id", "LanguageISO", "Title", "ProductVariantTypeId", "Sorting", "Color", "Picture"
  ],
  "ArrayOfProductvarianttypevalue": ["item"],
  "ProductVariantCreate": [
    "ProductId", "Stock", "StockLow", "Price", "BuyingPrice", "ItemNumber", "ItemNumberSupplier",
    "Weight", "DeliveryTimeId", "Status", "Description", "DescriptionLong", "DisableOnEmpty",
    "Discount", "DiscountType", "Ean", "PictureId", "PictureIds", "Sorting", "VariantTypeValues",
    "MinAmount", "UnitId"
  ],
  "ProductVariantUpdate": [
    "Id", "ProductId", "Stock", "StockLow", "Price", "BuyingPrice", "ItemNumber",
    "ItemNumberSupplier", "Weight", "DeliveryTimeId", "Status", "Description", "DescriptionLong",
    "DisableOnEmpty", "Discount", "DiscountType", "Ean", "PictureId", "PictureIds", "Sorting",
    "VariantTypeValues", "MinAmount", "UnitId"
  ],
  "ProductVariantCreateUpdate": [
    "ProductId", "Stock", "StockLow", "Price", "BuyingPrice", "ItemNumber", "ItemNumberSupplier",
    "Weight", "DeliveryTimeId", "Status", "Description", "DescriptionLong", "DisableOnEmpty",
    "Discount", "DiscountType", "Ean", "PictureId", "PictureIds", "Sorting", "VariantTypeValues",
    "MinAmount", "UnitId"
  ],
  "ProductDeliveryTime": ["Id", "LanguageISO", "Sorting", "TitleInStock", "TitleNoStock"],
  "ArrayOfProductdeliverytime": ["item"],
  "ProductDeliveryTimeCreate": ["LanguageISO", "Sorting", "TitleInStock", "TitleNoStock"],
  "ProductDeliveryTimeUpdate": ["Id", "LanguageISO", "Sorting", "TitleInStock", "TitleNoStock"],
  "ProductDeliveryCountry": ["Id", "Iso", "Code", "Tax", "CompanyTax", "Access", "Primary"],
  "ArrayOfProductdeliverycountry": ["item"],
  "ProductDeliveryCountryCreate": ["Iso", "Code", "Tax", "CompanyTax", "Access", "Primary"],
  "ProductDeliveryCountryUpdate": ["Id", "Iso", "Code", "Tax", "CompanyTax", "Access", "Primary"],
  "ProductPictureCreate": ["ProductId", "FileName", "Sorting", "ImageAltTexts"],
  "ProductFileCreate": ["ProductId", "FileName", "Sorting"],
  "ProductPictureUpdate": ["Id", "ProductId", "FileName", "Sorting", "ImageAltTexts"],
  "ProductFileUpdate": ["Id", "ProductId", "FileName", "Sorting"],
  "PagePicture": ["Id", "LanguageISO", "Name", "Thumbnail", "Sorting", "LanguageAccess", "ImageAltTexts"],
  "ArrayOfPagepicture": ["item"],
  "PageText": [
    "Id", "CategoryId", "Sorting", "ParentId", "ShowInMenu", "Target", "UpdatedDate", "LanguageISO",
    "Title", "Headline", "Link", "Text", "Text2", "Text3", "Visible", "SeoKeywords",
    "SeoDescription", "SeoTitle", "Pictures", "LanguageAccess"
  ],
  "ArrayOfPagetext": ["item"],
  "PageTextCreate": [
    "CategoryId", "Sorting", "ParentId", "Visible", "ShowInMenu", "UpdatedDate", "LanguageISO",
    "Title", "Headline", "Link", "Text", "LanguageAccess"
  ],
  "PageTextUpdate": [
    "Id", "CategoryId", "Sorting", "ParentId", "Visible", "ShowInMenu", "UpdatedDate",
    "LanguageISO", "Title", "Headline", "Link", "Text", "LanguageAccess"
  ],
  "ImageAltText": ["Text", "LanguageAccess"],
  "ArrayOfImageAltText": ["item"],
  "Delivery": [
    "Id", "Type", "ServiceType", "Vat", "FreeDeliveryActive", "FreeDeliveryPrice",
    "OverLimitFeeActive", "OverLimitFixedFee", "OverLimitPercentageFee", "UserGroups", "RegionMode",
    "ZipFrom", "ZipTo", "ZipGroups", "DeliveryEstimate", "MultipleAddresses", "FixedDelivery",
    "Sorting", "Primary", "Title", "Text", "LanguageISO", "Price"
  ],
  "ArrayOfDelivery": ["item"],
  "PaymentMethodOnline": ["Id", "Title", "FixedFee", "PercentageFee", "Icons", "Sorting"],
  "ArrayOfPaymentmethodonline": ["item"],
  "PaymentMethod": [
    "Id", "Title", "Description", "LanguageISO", "Sorting", "GatewayUserId", "GatewayUserName",
    "GatewayPassword", "OnlineMethods", "Type", "Vat", "FixedFee", "PercentageFee", "OrderStatus",
    "PaymentAcceptPath", "LanguageAccess"
  ],
  "ArrayOfPaymentmethod": ["item"],
  "DiscountedProductCategories": ["AssociationType", "CategoryIds"],
  "Discount": [
    "Id", "Title", "Type", "Value", "Code", "UseCount", "ProductIds", "DiscountCustomerAssociation",
    "DiscountCustomerGroupAssociation", "Limit", "DateExpire", "DateCreated", "AmountSpent",
    "AmountSpentPrecise", "Vat", "AllowDiscountedProducts", "StartDate", "IsActive",
    "IsRestrictedToNewCustomer", "MinimumCartValue", "DiscountedProductCategories",
    "IsSingleUsePerCustomer", "DeliveryMethodIds", "FreeGift"
  ],
  "DiscountFreeGift": ["ProductId", "VariantId", "Amount"],
  "DiscountCustomerAssociation": ["AssociationType", "CustomerIds"],
  "DiscountCustomerGroupAssociation": ["AssociationType", "CustomerGroupIds"],
  "ArrayOfDiscount": ["item"],
  "DiscountCreate": [
    "Title", "Type", "Value", "Code", "UseCount", "ProductIds", "DiscountCustomerAssociation",
    "DiscountCustomerGroupAssociation", "Limit", "DateExpire", "DateCreated", "AmountSpent",
    "AmountSpentPrecise", "Vat", "AllowDiscountedProducts", "StartDate", "IsActive",
    "IsRestrictedToNewCustomer", "MinimumCartValue", "DiscountedProductCategories",
    "IsSingleUsePerCustomer", "DeliveryMethodIds", "FreeGift"
  ],
  "DiscountUpdate": [
    "Id", "Title", "Type", "Value", "Code", "UseCount", "ProductIds", "DiscountCustomerAssociation",
    "DiscountCustomerGroupAssociation", "Limit", "DateExpire", "DateCreated", "AmountSpent",
    "AmountSpentPrecise", "Vat", "AllowDiscountedProducts", "StartDate", "IsActive",
    "IsRestrictedToNewCustomer", "MinimumCartValue", "DiscountedProductCategories",
    "IsSingleUsePerCustomer", "DeliveryMethodIds", "FreeGift"
  ],
  "SEORedirect": ["Id", "Source", "Target", "Type", "LanguageIso"],
  "ArrayOfSeoredirect": ["item"],
  "ArrayOfCustomdata": ["item"],
  "CustomData": ["Id", "CustomTypeId", "LanguageISO", "Title", "Sorting"],
  "CustomDataTypeCreate": ["Display", "Entity", "LanguageISO", "Sorting", "Title", "Type"],
  "CustomDataTypeUpdate": ["Display", "Entity", "Id", "LanguageISO", "Sorting", "Title", "Type"],
  "CustomDataCreate": ["CustomTypeId", "LanguageISO", "Title", "Sorting"],
  "CustomDataUpdate": ["Id", "CustomTypeId", "LanguageISO", "Title", "Sorting"],
  "CustomDataType": ["Display", "Entity", "Id", "LanguageISO", "Sorting", "Title", "Type"],
  "ArrayOfCustomdatatype": ["item"],
  "Site": ["Id", "LanguageISO", "Title", "Sorting", "Type"],
  "ArrayOfSite": ["item"],
  "ArrayOfVatgroup": ["item"],
  "VatGroupCreate": ["Name", "VatPercentage", "Sorting"],
  "VatGroupUpdate": ["Id", "Name", "VatPercentage", "Sorting"]
};

// The same types with their field types, for callers that need more than the names
// (e.g. deciding whether a field is a nested record or an array wrapper).
//   kind       — "all" | "sequence" | "empty"
//   arrayOf    — item type when this type is an array wrapper, else null
//   itemElement— name of the repeated child element ("item"), else null
export const TYPE_DETAILS = {
  "ShopWebinfo": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Company", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ContactPerson", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Address", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Zip", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "City", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Country", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Phone", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Mobile", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Fax", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Email", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "EmailDummy", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Cvr", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "BankInfo", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ProductPricesWithVat", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "ShowProductPricesWithVat", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "SolutionId", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ArrayOfString": {
    "kind": "sequence",
    "arrayOf": "xsd:string",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "xsd:string", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "SolutionLanguage": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Primary", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Status", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "SiteId", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ArrayOfSolutionlanguage": {
    "kind": "sequence",
    "arrayOf": "tns:SolutionLanguage",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:SolutionLanguage", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "User": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Username", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Password", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "UserGroupId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Type", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Company", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "CustomData", "type": "tns:ArrayOfCustomdata", "nillable": false, "required": false },
      { "name": "Cvr", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Ean", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Firstname", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Lastname", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Sex", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Address", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Address2", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Zip", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "City", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Country", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "CountryCode", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Currency", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Phone", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Mobile", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Fax", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Email", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Url", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DiscountGroupId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Newsletter", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Referer", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "BirthDate", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DateCreated", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DateUpdated", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Approved", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "LanguageAccess", "type": "tns:ArrayOfString", "nillable": false, "required": false },
      { "name": "Description", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "InterestFields", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "Number", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Site", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ShippingType", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingFirstname", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingLastname", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCompany", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCvr", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingEan", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingAddress", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingAddress2", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingZip", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCity", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCountry", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCountryCode", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ShippingState", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingPhone", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingMobile", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingEmail", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingReferenceNumber", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Consent", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "ConsentDate", "type": "xsd:string", "nillable": false, "required": false }
    ]
  },
  "ArrayOfUser": {
    "kind": "sequence",
    "arrayOf": "tns:User",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:User", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "UserCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Username", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Password", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "UserGroupId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Type", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Company", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Cvr", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Ean", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Firstname", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Lastname", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sex", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Address", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Address2", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Zip", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "City", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Country", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "CountryCode", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Currency", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Phone", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Mobile", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Fax", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Email", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Url", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DiscountGroupId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Newsletter", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Referer", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "BirthDate", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DateCreated", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DateUpdated", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Approved", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Site", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "LanguageAccess", "type": "tns:ArrayOfString", "nillable": false, "required": false },
      { "name": "Description", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "InterestFields", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "Number", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoDescription", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoTitle", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingType", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingFirstname", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingLastname", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCompany", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCvr", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingEan", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingAddress", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingAddress2", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingZip", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCity", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCountry", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCountryCode", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ShippingState", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingPhone", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingEmail", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingReferenceNumber", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Consent", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "ConsentDate", "type": "xsd:string", "nillable": false, "required": false }
    ]
  },
  "UserUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Username", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Password", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "UserGroupId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Type", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Company", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Cvr", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Ean", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Firstname", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Lastname", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Sex", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Address", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Address2", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Zip", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "City", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Country", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "CountryCode", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Currency", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Phone", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Mobile", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Fax", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Email", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Url", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DiscountGroupId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Newsletter", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Referer", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "BirthDate", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DateCreated", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DateUpdated", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Approved", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Site", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "LanguageAccess", "type": "tns:ArrayOfString", "nillable": false, "required": false },
      { "name": "Description", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "InterestFields", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "Number", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoDescription", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoTitle", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingType", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingFirstname", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingLastname", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCompany", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCvr", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingEan", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingAddress", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingAddress2", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingZip", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCity", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCountry", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCountryCode", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ShippingState", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingPhone", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingMobile", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingEmail", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingReferenceNumber", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Consent", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "ConsentDate", "type": "xsd:string", "nillable": false, "required": false }
    ]
  },
  "UserCreateUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Username", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Password", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "UserGroupId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Type", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Company", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Cvr", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Ean", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Firstname", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Lastname", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Sex", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Address", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Address2", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Zip", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "City", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Country", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "CountryCode", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Currency", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Phone", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Mobile", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Fax", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Email", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Url", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DiscountGroupId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Newsletter", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Referer", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "BirthDate", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DateCreated", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DateUpdated", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Approved", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Site", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "LanguageAccess", "type": "tns:ArrayOfString", "nillable": false, "required": false },
      { "name": "Description", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "InterestFields", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "Number", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoDescription", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoTitle", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingType", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingFirstname", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingLastname", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCompany", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCvr", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingEan", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingAddress", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingAddress2", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingZip", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCity", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCountry", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCountryCode", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ShippingState", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingPhone", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingMobile", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingEmail", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingReferenceNumber", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Consent", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "ConsentDate", "type": "xsd:string", "nillable": false, "required": false }
    ]
  },
  "UserGroup": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Description", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "InterestFields", "type": "tns:ArrayOfInt", "nillable": false, "required": true },
      { "name": "ParentId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Producer", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ArrayOfUsergroup": {
    "kind": "sequence",
    "arrayOf": "tns:UserGroup",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:UserGroup", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "UserGroupCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Description", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ParentId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Producer", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "UserGroupUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Description", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ParentId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Producer", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "NewsletterCustomField": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Name", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Type", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Default", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "UserGroupId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ServiceId", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ArrayOfNewslettercustomfield": {
    "kind": "sequence",
    "arrayOf": "tns:NewsletterCustomField",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:NewsletterCustomField", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "Category": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Description", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DescriptionBottom", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "SeoDescripton", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "SeoKeywords", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "SeoTitle", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "SeoLink", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "SeoCanonical", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ParentId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Status", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageAccess", "type": "tns:ArrayOfString", "nillable": false, "required": true },
      { "name": "UserGroupAccessIds", "type": "tns:ArrayOfInt", "nillable": false, "required": true },
      { "name": "ShowInMenu", "type": "tns:ArrayOfInt", "nillable": true, "required": true }
    ]
  },
  "ArrayOfCategory": {
    "kind": "sequence",
    "arrayOf": "tns:Category",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:Category", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "CategoryCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Description", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DescriptionBottom", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "SeoTitle", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoDescription", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoKeywords", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoLink", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoCanonical", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ParentId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Status", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageAccess", "type": "tns:ArrayOfString", "nillable": false, "required": false },
      { "name": "UserGroupAccessIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "ShowInMenu", "type": "tns:ArrayOfInt", "nillable": true, "required": false }
    ]
  },
  "CategoryUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Description", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DescriptionBottom", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ParentId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoTitle", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoDescription", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoKeywords", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoLink", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoCanonical", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Status", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "LanguageAccess", "type": "tns:ArrayOfString", "nillable": false, "required": false },
      { "name": "UserGroupAccessIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "ShowInMenu", "type": "tns:ArrayOfInt", "nillable": true, "required": false }
    ]
  },
  "CategoryCreateUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Description", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DescriptionBottom", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoTitle", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoDescription", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoKeywords", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoLink", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoCanonical", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ParentId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Status", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "LanguageAccess", "type": "tns:ArrayOfString", "nillable": false, "required": false },
      { "name": "UserGroupAccessIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "ShowInMenu", "type": "tns:ArrayOfInt", "nillable": true, "required": false }
    ]
  },
  "CategoryPicture": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "CategoryId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Name", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ImageAltTexts", "type": "tns:ArrayOfImageAltText", "nillable": false, "required": false }
    ]
  },
  "ArrayOfCategorypicture": {
    "kind": "sequence",
    "arrayOf": "tns:CategoryPicture",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:CategoryPicture", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "CategoryPictureCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "CategoryId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Name", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ImageAltTexts", "type": "tns:ArrayOfImageAltText", "nillable": false, "required": false }
    ]
  },
  "CategoryPictureUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "CategoryId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Name", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ImageAltTexts", "type": "tns:ArrayOfImageAltText", "nillable": false, "required": false }
    ]
  },
  "ProductDiscount": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ProductVariantId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Amount", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Price", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "Discount", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "Currency", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DiscountType", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "UserType", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "UserId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Date", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "DateFrom", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DateTo", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Accumulate", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Site", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Language", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ArrayOfProductdiscount": {
    "kind": "sequence",
    "arrayOf": "tns:ProductDiscount",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductDiscount", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ProductDiscountCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ProductVariantId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Amount", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Price", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "Discount", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "Currency", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DiscountType", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "UserType", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "UserId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Date", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "DateFrom", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DateTo", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Accumulate", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Site", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Language", "type": "xsd:string", "nillable": false, "required": false }
    ]
  },
  "ProductDiscountUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ProductVariantId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Amount", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Price", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "Discount", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "Currency", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DiscountType", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "UserType", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "UserId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Date", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "DateFrom", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DateTo", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Accumulate", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Site", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Language", "type": "xsd:string", "nillable": false, "required": false }
    ]
  },
  "ProductDiscountAccumulative": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Type1", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Type1Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Type2", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Type2Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Amount", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Discount", "type": "xsd:float", "nillable": false, "required": true },
      { "name": "Currency", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Date", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "DateFrom", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DateTo", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Site", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Language", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ArrayOfProductdiscountaccumulative": {
    "kind": "sequence",
    "arrayOf": "tns:ProductDiscountAccumulative",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductDiscountAccumulative", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ProductDiscountAccumulativeCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Type1", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Type1Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Type2", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Type2Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Amount", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Discount", "type": "xsd:float", "nillable": false, "required": true },
      { "name": "Currency", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Date", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "DateFrom", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DateTo", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Site", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Language", "type": "xsd:string", "nillable": false, "required": false }
    ]
  },
  "ProductDiscountAccumulativeUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Type1", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Type1Id", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Type2", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Type2Id", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Amount", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Discount", "type": "xsd:float", "nillable": false, "required": false },
      { "name": "Currency", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Date", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "DateFrom", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DateTo", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Site", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Language", "type": "xsd:string", "nillable": false, "required": false }
    ]
  },
  "ProductUnit": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ArrayOfProductunit": {
    "kind": "sequence",
    "arrayOf": "tns:ProductUnit",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductUnit", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ProductUnitCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ProductUnitUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": false }
    ]
  },
  "Currency": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Iso", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Symbol", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "SymbolPlace", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Currency", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "Decimal", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DecimalCount", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Point", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Round", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "RoundOn", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ArrayOfCurrency": {
    "kind": "sequence",
    "arrayOf": "tns:Currency",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:Currency", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "CurrencyCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Iso", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Symbol", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "SymbolPlace", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Currency", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "Decimal", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DecimalCount", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Point", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Round", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "CurrencyUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Iso", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Symbol", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SymbolPlace", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Currency", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "Decimal", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DecimalCount", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Point", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Round", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": false }
    ]
  },
  "OrderCurrency": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Iso", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Symbol", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "SymbolPlace", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Currency", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "Decimal", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Point", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Round", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "OrderCustomer": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Firstname", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Lastname", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Company", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "B2B", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Cvr", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Ean", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Address", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Address2", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Zip", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "City", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Country", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "CountryCode", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "State", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Phone", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Mobile", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Email", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ShippingFirstname", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ShippingLastname", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ShippingCompany", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ShippingAddress", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ShippingAddress2", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ShippingZip", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ShippingCity", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ShippingCountry", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ShippingCountryCode", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ShippingState", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ShippingPhone", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ShippingMobile", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ShippingEmail", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "OrderPayment": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "PaymentMethodId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Price", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "Vat", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "ExternalId", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "OrderTransaction": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "PaymentId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Status", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "TransactionNumber", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "TransactionNumberLong", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "SubscriptionId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "SubscriptionIdLong", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Cardtype", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Amount", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "AmountFull", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "AmountOriginal", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "Currency", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Errorcode", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Actioncode", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Date", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ArrayOfOrdertransaction": {
    "kind": "sequence",
    "arrayOf": "tns:OrderTransaction",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:OrderTransaction", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "OrderLineAddress": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LineId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Amount", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Firstname", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Lastname", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Company", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Address", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Zip", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "City", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "CountryIso", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Comment", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DeliveryDate", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DeliveryTime", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ArrayOfOrderlineaddress": {
    "kind": "sequence",
    "arrayOf": "tns:OrderLineAddress",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:OrderLineAddress", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "OrderLine": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "VariantId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "FileDownloadId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Amount", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "PacketLines", "type": "tns:ArrayOfOrderline", "nillable": false, "required": true },
      { "name": "PacketTitle", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "PacketId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ProductTitle", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "VariantTitle", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "AdditionalTitle", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ItemNumber", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ItemNumberSupplier", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Discount", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "DiscountRounded", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "Price", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "PriceRounded", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "ServiceType", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "BuyPrice", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "StockStatus", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Status", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "TrackingCode", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Weight", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "LineAddresses", "type": "tns:ArrayOfOrderlineaddress", "nillable": false, "required": true },
      { "name": "OfflineProduct", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "VatRate", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "StockLocationId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "DeliveryId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Unit", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ExtendedDataInternal", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ExtendedDataExternal", "type": "xsd:string", "nillable": false, "required": false }
    ]
  },
  "ArrayOfOrderline": {
    "kind": "sequence",
    "arrayOf": "tns:OrderLine",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:OrderLine", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "OrderPacking": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Text", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "From", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "OrderDelivery": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "DeliveryMethodId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Vat", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Price", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "BuyPrice", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "ServiceType", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DroppointId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "DroppointIdLong", "type": "xsd:string", "nillable": false, "required": false }
    ]
  },
  "OrderDiscountCode": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "DiscountId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Type", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Value", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "Discount", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "Vat", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "IsNewGiftCard", "type": "xsd:boolean", "nillable": false, "required": true }
    ]
  },
  "ArrayOfOrderdiscountcode": {
    "kind": "sequence",
    "arrayOf": "tns:OrderDiscountCode",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:OrderDiscountCode", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "Order": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "InvoiceNumber", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "CurrencyId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Currency", "type": "tns:OrderCurrency", "nillable": false, "required": false },
      { "name": "CustomerId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Customer", "type": "tns:OrderCustomer", "nillable": false, "required": false },
      { "name": "UserId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "User", "type": "tns:User", "nillable": false, "required": false },
      { "name": "Site", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Status", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "PaymentId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Payment", "type": "tns:OrderPayment", "nillable": false, "required": false },
      { "name": "Transactions", "type": "tns:ArrayOfOrdertransaction", "nillable": false, "required": false },
      { "name": "Vat", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "Total", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "OrderComment", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "OrderCommentExternal", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "CustomerComment", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DeliveryComment", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DeliveryTime", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "TrackingCode", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DateDelivered", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DateDue", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DateSent", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DateUpdated", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "OrderLines", "type": "tns:ArrayOfOrderline", "nillable": false, "required": false },
      { "name": "PackingId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Packing", "type": "tns:OrderPacking", "nillable": false, "required": false },
      { "name": "DeliveryId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Delivery", "type": "tns:OrderDelivery", "nillable": false, "required": false },
      { "name": "DiscountCodes", "type": "tns:ArrayOfOrderdiscountcode", "nillable": false, "required": false },
      { "name": "ReferenceNumber", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Origin", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ReferralCode", "type": "xsd:string", "nillable": false, "required": false }
    ]
  },
  "ArrayOfOrder": {
    "kind": "sequence",
    "arrayOf": "tns:Order",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:Order", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "OrderLineCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "VariantId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "FileDownloadId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ServiceType", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "TrackingCode", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Status", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Amount", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Discount", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "Price", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "BuyPrice", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "Unit", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ExtendedDataInternal", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ExtendedDataExternal", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Vat", "type": "xsd:double", "nillable": false, "required": false }
    ]
  },
  "ArrayOfOrderlinecreate": {
    "kind": "sequence",
    "arrayOf": "tns:OrderLineCreate",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:OrderLineCreate", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "OrderCustomerCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Firstname", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Lastname", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Company", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Cvr", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "B2B", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Ean", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Address", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Address2", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Zip", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "City", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Country", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "CountryCode", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "State", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Phone", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Mobile", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Email", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ShippingFirstname", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingLastname", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCompany", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingAddress", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingAddress2", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingZip", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCity", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCountry", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingCountryCode", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingState", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingPhone", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingMobile", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ShippingEmail", "type": "xsd:string", "nillable": false, "required": false }
    ]
  },
  "OrderTransactionCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "PaymentId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Status", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "TransactionNumber", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "TransactionNumberLong", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SubscriptionId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "SubscriptionIdLong", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Cardtype", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Amount", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Currency", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Errorcode", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Actioncode", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Date", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "OrderCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "CurrencyId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "SiteId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "UserId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "PaymentId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "PaymentOnlineId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "CustomerComment", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DeliveryId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "DeliveryComment", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DeliveryPrice", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "DeliveryTime", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ReferenceNumber", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "OrderLines", "type": "tns:ArrayOfOrderlinecreate", "nillable": false, "required": true },
      { "name": "OrderCustomer", "type": "tns:OrderCustomerCreate", "nillable": false, "required": true },
      { "name": "OrderTransaction", "type": "tns:OrderTransactionCreate", "nillable": false, "required": false },
      { "name": "Origin", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Delivery", "type": "tns:OrderDelivery", "nillable": false, "required": false },
      { "name": "Vat", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "ReferralCode", "type": "xsd:string", "nillable": false, "required": false }
    ]
  },
  "OrderFileDownload": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "OrderId", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Count", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "DateFrom", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DateTo", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "OrderStatusCode": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ArrayOfOrderStatusCode": {
    "kind": "sequence",
    "arrayOf": "tns:OrderStatusCode",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:OrderStatusCode", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "OrderSetTransactionCode": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "OrderId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "PaymentId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Status", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "TransactionNumber", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "TransactionNumberLong", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SubscriptionId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Cardtype", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Amount", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Currency", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Errorcode", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Actioncode", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Date", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ArrayOfInt": {
    "kind": "sequence",
    "arrayOf": "xsd:int",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "xsd:int", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "DiscountGroup": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Type", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Discount", "type": "xsd:double", "nillable": false, "required": true }
    ]
  },
  "ProductVariant": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Stock", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "StockLow", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Price", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "BuyingPrice", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "ItemNumber", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ItemNumberSupplier", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Weight", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "DeliveryTime", "type": "tns:ProductDeliveryTime", "nillable": false, "required": false },
      { "name": "DeliveryTimeId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Description", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DescriptionLong", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Status", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "DisableOnEmpty", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Discount", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "DiscountType", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Ean", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "PictureId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "PictureIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "VariantTypeValues", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "MinAmount", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Unit", "type": "tns:ProductUnit", "nillable": false, "required": false },
      { "name": "StockLocations", "type": "tns:ArrayOfProductVariantStockLocation", "nillable": false, "required": false }
    ]
  },
  "ArrayOfProductvariant": {
    "kind": "sequence",
    "arrayOf": "tns:ProductVariant",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductVariant", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ProductTag": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "UserId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Username", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "UserEmail", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Rating", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Text", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DateCreated", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ArrayOfProducttag": {
    "kind": "sequence",
    "arrayOf": "tns:ProductTag",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductTag", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ProductPicture": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "FileName", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ImageAltTexts", "type": "tns:ArrayOfImageAltText", "nillable": false, "required": false }
    ]
  },
  "ArrayOfProductpicture": {
    "kind": "sequence",
    "arrayOf": "tns:ProductPicture",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductPicture", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ProductFile": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "FileName", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ArrayOfProductfile": {
    "kind": "sequence",
    "arrayOf": "tns:ProductFile",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductFile", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ProductCustomData": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ProductCustomId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ProductCustomIds", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ProductCustomTypeId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ArrayOfProductcustomdata": {
    "kind": "sequence",
    "arrayOf": "tns:ProductCustomData",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductCustomData", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ProductAdditionalType": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "CategoryId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ArrayOfProductadditionaltype": {
    "kind": "sequence",
    "arrayOf": "tns:ProductAdditionalType",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductAdditionalType", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ProductExtraBuyRelation": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "RelationProductId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ExtraBuyCategoryId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ArrayOfProductextrabuyrelation": {
    "kind": "sequence",
    "arrayOf": "tns:ProductExtraBuyRelation",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductExtraBuyRelation", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "PacketProductLine": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Amount", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Product", "type": "tns:Product", "nillable": false, "required": true },
      { "name": "VariantIds", "type": "tns:ArrayOfInt", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ArrayOfPacketproductline": {
    "kind": "sequence",
    "arrayOf": "tns:PacketProductLine",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:PacketProductLine", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "VatGroup": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Name", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "VatPercentage", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "Product": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "CategoryId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Category", "type": "tns:Category", "nillable": false, "required": false },
      { "name": "SecondaryCategoryIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "SecondaryCategories", "type": "tns:ArrayOfCategory", "nillable": false, "required": false },
      { "name": "ProducerId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Producer", "type": "tns:User", "nillable": false, "required": false },
      { "name": "Online", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Status", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "DisableOnEmpty", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "CallForPrice", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Stock", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ItemNumber", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ItemNumberSupplier", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "RelationCode", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Url", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Weight", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "BuyingPrice", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "Price", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "Discount", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "DiscountType", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Delivery", "type": "tns:Delivery", "nillable": false, "required": false },
      { "name": "DeliveryId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "DeliveryTime", "type": "tns:ProductDeliveryTime", "nillable": false, "required": false },
      { "name": "DeliveryTimeId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "DiscountGroupId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "DiscountGroup", "type": "tns:DiscountGroup", "nillable": false, "required": false },
      { "name": "Ean", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "FocusFrontpage", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "FocusCart", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "DateCreated", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DateUpdated", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "RelatedProductIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoTitle", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoDescription", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoKeywords", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoLink", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoCanonical", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Description", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DescriptionShort", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DescriptionLong", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Variants", "type": "tns:ArrayOfProductvariant", "nillable": false, "required": false },
      { "name": "Tags", "type": "tns:ArrayOfProducttag", "nillable": false, "required": false },
      { "name": "Pictures", "type": "tns:ArrayOfProductpicture", "nillable": false, "required": false },
      { "name": "CustomData", "type": "tns:ArrayOfProductcustomdata", "nillable": false, "required": false },
      { "name": "Additionals", "type": "tns:ArrayOfProductadditionaltype", "nillable": false, "required": false },
      { "name": "ExtraBuyRelations", "type": "tns:ArrayOfProductextrabuyrelation", "nillable": false, "required": false },
      { "name": "UnitId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Unit", "type": "tns:ProductUnit", "nillable": false, "required": false },
      { "name": "UserAccess", "type": "tns:ArrayOfUser", "nillable": false, "required": false },
      { "name": "UserAccessIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "UserGroupAccess", "type": "tns:ArrayOfUsergroup", "nillable": false, "required": false },
      { "name": "UserGroupAccessIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "Discounts", "type": "tns:ArrayOfProductdiscount", "nillable": false, "required": false },
      { "name": "MinAmount", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "VariantTypes", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "GuidelinePrice", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "ProductUrl", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Type", "type": "xsd:anyType", "nillable": false, "required": false },
      { "name": "PacketProducts", "type": "tns:ArrayOfPacketproductline", "nillable": false, "required": false },
      { "name": "LanguageAccess", "type": "tns:ArrayOfString", "nillable": false, "required": false },
      { "name": "VatGroupId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "VatGroup", "type": "tns:VatGroup", "nillable": false, "required": false },
      { "name": "AutoStock", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "CategorySortings", "type": "tns:ArrayOfProductCategorySorting", "nillable": false, "required": false },
      { "name": "OutOfStockBuy", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "StockLow", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "StockLocations", "type": "tns:ArrayOfProductStockLocation", "nillable": false, "required": false },
      { "name": "TypeLabel", "type": "xsd:string", "nillable": false, "required": false }
    ]
  },
  "ArrayOfProduct": {
    "kind": "sequence",
    "arrayOf": "tns:Product",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:Product", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ProductCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "CategoryId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "SecondaryCategoryIds", "type": "tns:ArrayOfInt", "nillable": false, "required": true },
      { "name": "ProducerId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Online", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Status", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "DisableOnEmpty", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Ean", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "CallForPrice", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Stock", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ItemNumber", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ItemNumberSupplier", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Url", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "RelationCode", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Weight", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "BuyingPrice", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "Price", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "Discount", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "DiscountType", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DeliveryId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "DeliveryTimeId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "DiscountGroupId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "FocusFrontpage", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "FocusCart", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "DateCreated", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DateUpdated", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "RelatedProducts", "type": "tns:ArrayOfInt", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "SeoTitle", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "SeoDescription", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "SeoKeywords", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "SeoLink", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoCanonical", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Description", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DescriptionShort", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DescriptionLong", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "UnitId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "UserAccessIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "UserGroupAccessIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "MinAmount", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "GuidelinePrice", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "LanguageAccess", "type": "tns:ArrayOfString", "nillable": false, "required": false },
      { "name": "VatGroupId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "AutoStock", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "CategorySortings", "type": "tns:ArrayOfProductCategorySorting", "nillable": false, "required": false },
      { "name": "OutOfStockBuy", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "StockLow", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "TypeLabel", "type": "xsd:string", "nillable": false, "required": false }
    ]
  },
  "ProductUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "CategoryId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "SecondaryCategoryIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "ProducerId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Online", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Status", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "DisableOnEmpty", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Ean", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "CallForPrice", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Stock", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ItemNumber", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ItemNumberSupplier", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Url", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Weight", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "BuyingPrice", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "Price", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "Discount", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "DiscountType", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DeliveryId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "DeliveryTimeId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "DiscountGroupId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "FocusFrontpage", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "FocusCart", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "DateCreated", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DateUpdated", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "RelatedProducts", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoTitle", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoDescription", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoKeywords", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoLink", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoCanonical", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Description", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DescriptionShort", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DescriptionLong", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "UnitId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "UserAccessIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "UserGroupAccessIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "MinAmount", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "GuidelinePrice", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "LanguageAccess", "type": "tns:ArrayOfString", "nillable": false, "required": false },
      { "name": "VatGroupId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "AutoStock", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "CategorySortings", "type": "tns:ArrayOfProductCategorySorting", "nillable": false, "required": false },
      { "name": "OutOfStockBuy", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "StockLow", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "TypeLabel", "type": "xsd:string", "nillable": false, "required": false }
    ]
  },
  "ProductCreateUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "CategoryId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "SecondaryCategoryIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "ProducerId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Online", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Status", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "DisableOnEmpty", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Ean", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "CallForPrice", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Stock", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ItemNumber", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ItemNumberSupplier", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Url", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "RelationCode", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Weight", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "BuyingPrice", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "Price", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "Discount", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "DiscountType", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DeliveryId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "DeliveryTimeId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "DiscountGroupId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "FocusFrontpage", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "FocusCart", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "DateCreated", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DateUpdated", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "RelatedProducts", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoTitle", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoDescription", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoKeywords", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoLink", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoCanonical", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Description", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DescriptionShort", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DescriptionLong", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "UnitId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "UserAccessIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "UserGroupAccessIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "MinAmount", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "GuidelinePrice", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "LanguageAccess", "type": "tns:ArrayOfString", "nillable": false, "required": false },
      { "name": "VatGroupId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "AutoStock", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "CategorySortings", "type": "tns:ArrayOfProductCategorySorting", "nillable": false, "required": false },
      { "name": "OutOfStockBuy", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "StockLow", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "TypeLabel", "type": "xsd:string", "nillable": false, "required": false }
    ]
  },
  "ProductCreateOrUpdateBulkResult": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Error", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ArrayOfProductCreateUpdate": {
    "kind": "sequence",
    "arrayOf": "tns:ProductCreateUpdate",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductCreateUpdate", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ArrayOfProductCreateOrUpdateBulkResult": {
    "kind": "sequence",
    "arrayOf": "tns:ProductCreateOrUpdateBulkResult",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductCreateOrUpdateBulkResult", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ProductCategorySorting": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "CategoryId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ProductStockLocation": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "StockLocationId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "DeliveryTimeId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Stock", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "BuyPrice", "type": "xsd:float", "nillable": false, "required": true }
    ]
  },
  "ProductVariantStockLocation": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "StockLocationId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "DeliveryTimeId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Stock", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "BuyPrice", "type": "xsd:float", "nillable": false, "required": true }
    ]
  },
  "ArrayOfProductCategorySorting": {
    "kind": "sequence",
    "arrayOf": "tns:ProductCategorySorting",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductCategorySorting", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ArrayOfProductStockLocation": {
    "kind": "sequence",
    "arrayOf": "tns:ProductStockLocation",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductStockLocation", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ArrayOfProductVariantStockLocation": {
    "kind": "sequence",
    "arrayOf": "tns:ProductVariantStockLocation",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductVariantStockLocation", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ProductAdditional": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ProductAdditionalTypeId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Price", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ArrayOfProductadditional": {
    "kind": "sequence",
    "arrayOf": "tns:ProductAdditional",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductAdditional", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ProductCustomDataCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "ProductCustomId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ProductCustomTypeId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ProductCustomDataUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ProductCustomId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ProductCustomTypeId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false }
    ]
  },
  "ProductCustomDataTypeCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Display", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Type", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ProductCustomDataTypeUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Display", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Type", "type": "xsd:int", "nillable": false, "required": false }
    ]
  },
  "ProductCustomDataType": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "CategoryId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Display", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Type", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ArrayOfProductcustomdatatype": {
    "kind": "sequence",
    "arrayOf": "tns:ProductCustomDataType",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductCustomDataType", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ArrayOfDiscountgroup": {
    "kind": "sequence",
    "arrayOf": "tns:DiscountGroup",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:DiscountGroup", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "DiscountGroupCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Type", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Discount", "type": "xsd:double", "nillable": false, "required": true }
    ]
  },
  "DiscountGroupUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Type", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Discount", "type": "xsd:double", "nillable": false, "required": true }
    ]
  },
  "DiscountGroupProduct": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ArrayOfDiscountgroupproduct": {
    "kind": "sequence",
    "arrayOf": "tns:DiscountGroupProduct",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:DiscountGroupProduct", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "DiscountGroupProductCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "DiscountGroupProductUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ProductExtraBuyRelationCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "RelationProductId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ExtraBuyCategoryId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ProductExtraBuyRelationUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "RelationProductId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ExtraBuyCategoryId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false }
    ]
  },
  "ProductExtraBuyCategory": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ParentId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ArrayOfProductextrabuycategory": {
    "kind": "sequence",
    "arrayOf": "tns:ProductExtraBuyCategory",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductExtraBuyCategory", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ProductExtraBuyCategoryCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ParentId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ProductExtraBuyCategoryUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ParentId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false }
    ]
  },
  "ProductVariantTypeCreateUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false }
    ]
  },
  "ProductVariantTypeUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ArrayOfProductvarianttype": {
    "kind": "sequence",
    "arrayOf": "tns:ProductVariantType",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductVariantType", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ProductVariantType": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ProductVariantTypeValueCreateUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ProductVariantTypeId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false }
    ]
  },
  "ProductVariantTypeValueUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ProductVariantTypeId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ProductVariantTypeValue": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ProductVariantTypeId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Color", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Picture", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ArrayOfProductvarianttypevalue": {
    "kind": "sequence",
    "arrayOf": "tns:ProductVariantTypeValue",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductVariantTypeValue", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ProductVariantCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Stock", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "StockLow", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Price", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "BuyingPrice", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "ItemNumber", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ItemNumberSupplier", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Weight", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "DeliveryTimeId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Status", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Description", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DescriptionLong", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DisableOnEmpty", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Discount", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "DiscountType", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Ean", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "PictureId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "PictureIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "VariantTypeValues", "type": "tns:ArrayOfInt", "nillable": false, "required": true },
      { "name": "MinAmount", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "UnitId", "type": "xsd:int", "nillable": false, "required": false }
    ]
  },
  "ProductVariantUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Stock", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "StockLow", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Price", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "BuyingPrice", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "ItemNumber", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "ItemNumberSupplier", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Weight", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "DeliveryTimeId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Status", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Description", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DescriptionLong", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DisableOnEmpty", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Discount", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "DiscountType", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Ean", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "PictureId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "PictureIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "VariantTypeValues", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "MinAmount", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "UnitId", "type": "xsd:int", "nillable": false, "required": false }
    ]
  },
  "ProductVariantCreateUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Stock", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "StockLow", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Price", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "BuyingPrice", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "ItemNumber", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ItemNumberSupplier", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Weight", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "DeliveryTimeId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Status", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Description", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DescriptionLong", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DisableOnEmpty", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Discount", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "DiscountType", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Ean", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "PictureId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "PictureIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "VariantTypeValues", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "MinAmount", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "UnitId", "type": "xsd:int", "nillable": false, "required": false }
    ]
  },
  "ProductDeliveryTime": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "TitleInStock", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "TitleNoStock", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ArrayOfProductdeliverytime": {
    "kind": "sequence",
    "arrayOf": "tns:ProductDeliveryTime",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductDeliveryTime", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ProductDeliveryTimeCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "TitleInStock", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "TitleNoStock", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ProductDeliveryTimeUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "TitleInStock", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "TitleNoStock", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ProductDeliveryCountry": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Iso", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Code", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Tax", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "CompanyTax", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Access", "type": "tns:ArrayOfString", "nillable": false, "required": true },
      { "name": "Primary", "type": "xsd:boolean", "nillable": false, "required": true }
    ]
  },
  "ArrayOfProductdeliverycountry": {
    "kind": "sequence",
    "arrayOf": "tns:ProductDeliveryCountry",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ProductDeliveryCountry", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ProductDeliveryCountryCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Iso", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Code", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Tax", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "CompanyTax", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Access", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Primary", "type": "xsd:boolean", "nillable": false, "required": true }
    ]
  },
  "ProductDeliveryCountryUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Iso", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Code", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Tax", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "CompanyTax", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Access", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Primary", "type": "xsd:boolean", "nillable": false, "required": false }
    ]
  },
  "ProductPictureCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "FileName", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ImageAltTexts", "type": "tns:ArrayOfImageAltText", "nillable": false, "required": false }
    ]
  },
  "ProductFileCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "FileName", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ProductPictureUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "FileName", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ImageAltTexts", "type": "tns:ArrayOfImageAltText", "nillable": false, "required": false }
    ]
  },
  "ProductFileUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "FileName", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false }
    ]
  },
  "PagePicture": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Name", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Thumbnail", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageAccess", "type": "tns:ArrayOfString", "nillable": false, "required": true },
      { "name": "ImageAltTexts", "type": "tns:ArrayOfImageAltText", "nillable": false, "required": false }
    ]
  },
  "ArrayOfPagepicture": {
    "kind": "sequence",
    "arrayOf": "tns:PagePicture",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:PagePicture", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "PageText": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "CategoryId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ParentId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ShowInMenu", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Target", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "UpdatedDate", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Headline", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Link", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Text", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Text2", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Text3", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Visible", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "SeoKeywords", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoDescription", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "SeoTitle", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Pictures", "type": "tns:ArrayOfPagepicture", "nillable": false, "required": false },
      { "name": "LanguageAccess", "type": "tns:ArrayOfString", "nillable": false, "required": false }
    ]
  },
  "ArrayOfPagetext": {
    "kind": "sequence",
    "arrayOf": "tns:PageText",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:PageText", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "PageTextCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "CategoryId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ParentId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Visible", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ShowInMenu", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "UpdatedDate", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Headline", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Link", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Text", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "LanguageAccess", "type": "tns:ArrayOfString", "nillable": false, "required": false }
    ]
  },
  "PageTextUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "CategoryId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ParentId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Visible", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ShowInMenu", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "UpdatedDate", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Headline", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Link", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Text", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "LanguageAccess", "type": "tns:ArrayOfString", "nillable": false, "required": false }
    ]
  },
  "ImageAltText": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Text", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "LanguageAccess", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ArrayOfImageAltText": {
    "kind": "sequence",
    "arrayOf": "tns:ImageAltText",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:ImageAltText", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "Delivery": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Type", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "ServiceType", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Vat", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "FreeDeliveryActive", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "FreeDeliveryPrice", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "OverLimitFeeActive", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "OverLimitFixedFee", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "OverLimitPercentageFee", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "UserGroups", "type": "tns:ArrayOfInt", "nillable": false, "required": true },
      { "name": "RegionMode", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "ZipFrom", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ZipTo", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ZipGroups", "type": "tns:ArrayOfInt", "nillable": false, "required": true },
      { "name": "DeliveryEstimate", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "MultipleAddresses", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "FixedDelivery", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Primary", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Text", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Price", "type": "xsd:double", "nillable": false, "required": true }
    ]
  },
  "ArrayOfDelivery": {
    "kind": "sequence",
    "arrayOf": "tns:Delivery",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:Delivery", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "PaymentMethodOnline": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "FixedFee", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "PercentageFee", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "Icons", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ArrayOfPaymentmethodonline": {
    "kind": "sequence",
    "arrayOf": "tns:PaymentMethodOnline",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:PaymentMethodOnline", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "PaymentMethod": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Description", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "GatewayUserId", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "GatewayUserName", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "GatewayPassword", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "OnlineMethods", "type": "tns:ArrayOfPaymentmethodonline", "nillable": false, "required": true },
      { "name": "Type", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Vat", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "FixedFee", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "PercentageFee", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "OrderStatus", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "PaymentAcceptPath", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "LanguageAccess", "type": "tns:ArrayOfString", "nillable": false, "required": true }
    ]
  },
  "ArrayOfPaymentmethod": {
    "kind": "sequence",
    "arrayOf": "tns:PaymentMethod",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:PaymentMethod", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "DiscountedProductCategories": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "AssociationType", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "CategoryIds", "type": "tns:ArrayOfInt", "nillable": false, "required": true }
    ]
  },
  "Discount": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Type", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Value", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "Code", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "UseCount", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ProductIds", "type": "tns:ArrayOfInt", "nillable": false, "required": true },
      { "name": "DiscountCustomerAssociation", "type": "tns:DiscountCustomerAssociation", "nillable": false, "required": true },
      { "name": "DiscountCustomerGroupAssociation", "type": "tns:DiscountCustomerGroupAssociation", "nillable": false, "required": true },
      { "name": "Limit", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DateExpire", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DateCreated", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "AmountSpent", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "AmountSpentPrecise", "type": "xsd:float", "nillable": false, "required": true },
      { "name": "Vat", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "AllowDiscountedProducts", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "StartDate", "type": "xsd:dateTime", "nillable": false, "required": true },
      { "name": "IsActive", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "IsRestrictedToNewCustomer", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "MinimumCartValue", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "DiscountedProductCategories", "type": "tns:DiscountedProductCategories", "nillable": false, "required": true },
      { "name": "IsSingleUsePerCustomer", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "DeliveryMethodIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "FreeGift", "type": "tns:DiscountFreeGift", "nillable": false, "required": false }
    ]
  },
  "DiscountFreeGift": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "ProductId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "VariantId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Amount", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "DiscountCustomerAssociation": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "AssociationType", "type": "tns:AssociationType", "nillable": false, "required": true },
      { "name": "CustomerIds", "type": "tns:ArrayOfInt", "nillable": false, "required": true }
    ]
  },
  "DiscountCustomerGroupAssociation": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "AssociationType", "type": "tns:AssociationType", "nillable": false, "required": true },
      { "name": "CustomerGroupIds", "type": "tns:ArrayOfInt", "nillable": false, "required": true }
    ]
  },
  "ArrayOfDiscount": {
    "kind": "sequence",
    "arrayOf": "tns:Discount",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:Discount", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "DiscountCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Type", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Value", "type": "xsd:double", "nillable": false, "required": true },
      { "name": "Code", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "UseCount", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "ProductIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "DiscountCustomerAssociation", "type": "tns:DiscountCustomerAssociation", "nillable": false, "required": false },
      { "name": "DiscountCustomerGroupAssociation", "type": "tns:DiscountCustomerGroupAssociation", "nillable": false, "required": false },
      { "name": "Limit", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "DateExpire", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "DateCreated", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "AmountSpent", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "AmountSpentPrecise", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "Vat", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "AllowDiscountedProducts", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "StartDate", "type": "xsd:dateTime", "nillable": false, "required": false },
      { "name": "IsActive", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "IsRestrictedToNewCustomer", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "MinimumCartValue", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "DiscountedProductCategories", "type": "tns:DiscountedProductCategories", "nillable": false, "required": false },
      { "name": "IsSingleUsePerCustomer", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "DeliveryMethodIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "FreeGift", "type": "tns:DiscountFreeGift", "nillable": false, "required": false }
    ]
  },
  "DiscountUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Type", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Value", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "Code", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "UseCount", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "ProductIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "DiscountCustomerAssociation", "type": "tns:DiscountCustomerAssociation", "nillable": false, "required": false },
      { "name": "DiscountCustomerGroupAssociation", "type": "tns:DiscountCustomerGroupAssociation", "nillable": false, "required": false },
      { "name": "Limit", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "DateExpire", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "DateCreated", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "AmountSpent", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "AmountSpentPrecise", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "Vat", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "AllowDiscountedProducts", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "StartDate", "type": "xsd:dateTime", "nillable": false, "required": false },
      { "name": "IsActive", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "IsRestrictedToNewCustomer", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "MinimumCartValue", "type": "xsd:double", "nillable": false, "required": false },
      { "name": "DiscountedProductCategories", "type": "tns:DiscountedProductCategories", "nillable": false, "required": false },
      { "name": "IsSingleUsePerCustomer", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "DeliveryMethodIds", "type": "tns:ArrayOfInt", "nillable": false, "required": false },
      { "name": "FreeGift", "type": "tns:DiscountFreeGift", "nillable": false, "required": false }
    ]
  },
  "SEORedirect": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Source", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Target", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Type", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageIso", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ArrayOfSeoredirect": {
    "kind": "sequence",
    "arrayOf": "tns:SEORedirect",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:SEORedirect", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ArrayOfCustomdata": {
    "kind": "sequence",
    "arrayOf": "tns:CustomData",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:CustomData", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "CustomData": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "CustomTypeId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "CustomDataTypeCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Display", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Entity", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Type", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "CustomDataTypeUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Display", "type": "xsd:boolean", "nillable": false, "required": false },
      { "name": "Entity", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Type", "type": "xsd:int", "nillable": false, "required": false }
    ]
  },
  "CustomDataCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "CustomTypeId", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "CustomDataUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "CustomTypeId", "type": "xsd:int", "nillable": false, "required": false },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": false },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": false }
    ]
  },
  "CustomDataType": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Display", "type": "xsd:boolean", "nillable": false, "required": true },
      { "name": "Entity", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Type", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "ArrayOfCustomdatatype": {
    "kind": "sequence",
    "arrayOf": "tns:CustomDataType",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:CustomDataType", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "Site": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "LanguageISO", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Title", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Type", "type": "xsd:string", "nillable": false, "required": true }
    ]
  },
  "ArrayOfSite": {
    "kind": "sequence",
    "arrayOf": "tns:Site",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:Site", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "ArrayOfVatgroup": {
    "kind": "sequence",
    "arrayOf": "tns:VatGroup",
    "itemElement": "item",
    "fields": [
      { "name": "item", "type": "tns:VatGroup", "nillable": false, "required": false, "repeats": true }
    ]
  },
  "VatGroupCreate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Name", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "VatPercentage", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  },
  "VatGroupUpdate": {
    "kind": "all",
    "arrayOf": null,
    "itemElement": null,
    "fields": [
      { "name": "Id", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Name", "type": "xsd:string", "nillable": false, "required": true },
      { "name": "VatPercentage", "type": "xsd:int", "nillable": false, "required": true },
      { "name": "Sorting", "type": "xsd:int", "nillable": false, "required": true }
    ]
  }
};

// xsd:simpleType restrictions (enumerations) referenced by the operations above.
export const ENUMS = {
  "AssociationType": { "base": "xsd:string", "values": ["INCLUSION", "EXCLUSION"] }
};

function own(obj, key) {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key);
}

/** True when the WSDL declares this operation. Use it instead of catching. */
export function hasOperation(op) {
  return own(OPERATIONS, op);
}

/** True when the WSDL declares this complexType. */
export function hasType(typeName) {
  return own(TYPES, typeName);
}

/** The operation's spec. Throws on an unknown name (R27: never guess). */
export function operationFor(op) {
  if (!own(OPERATIONS, op)) {
    throw new Error(`Unknown DanDomain operation "${op}" — not in the WSDL (${OPERATION_COUNT} operations)`);
  }
  return OPERATIONS[op];
}

/**
 * Argument names, in the order the WSDL declares them.
 * R17/R27: callers must build their request from this, not from memory of the docs.
 */
export function argNamesFor(op) {
  return operationFor(op).args.map((a) => a.name);
}

/** The declared field names of a complexType. Throws on an unknown type (R4). */
export function fieldsFor(typeName) {
  if (!own(TYPES, typeName)) {
    throw new Error(`Unknown DanDomain type "${typeName}" — not in the WSDL`);
  }
  return TYPES[typeName];
}

/**
 * Pre-flight an argument object against the WSDL (R17/R27).
 *
 * unknown[]         — names the server would SILENTLY DROP, which then surfaces as a PHP
 *                     arity error ("Too few arguments to function WebService::X()"). This is
 *                     the half backed by three real breakages, and the half that fails .ok.
 * missingRequired[] — declared, NON-nillable arguments that are absent.
 * missingNillable[] — declared, nillable arguments that are absent. ADVISORY ONLY; it does
 *                     not fail .ok. minOccurs is absent on all 298 arguments in this
 *                     WSDL, so "declared" is not the same as "PHP requires it", and
 *                     data/probes/gaps.json sections.orderGetByDate proves the difference:
 *                     Order_GetByDate sent with Start+End and no Status element at all came
 *                     back ok with all 20 orders ("statusIsOptionalInPractice": true). Only
 *                     that one argument was probed live; the rest are grouped with it because
 *                     nillable="true" is the WSDL's only optionality signal.
 *
 * CALLER CONTRACT — this function's undefined/null rule is a REQUIREMENT ON THE SERIALISER,
 * not an observation about one. A key whose value is `undefined` is treated as ABSENT, so the
 * serialiser must DROP such keys instead of emitting an empty element for them; `null` is
 * treated as PRESENT, so the serialiser must emit the element. The probe's serialiser
 * (scripts/probe-dandomain.mjs:58) does not honour the first half — it walks Object.entries
 * and maps both null and undefined to "", emitting <Status></Status> either way. Against that
 * serialiser this function's missing* lists are conservative rather than wrong (an empty
 * element behaves like omission for Order_GetByDate — gaps.json "Status empty string": ok,
 * count 20), but unknown[] is the only half that is exactly right. Nothing here emits XML and
 * no xsi:nil was ever observed on the wire; use orderedArgs() to build the element list so the
 * contract lives in one place.
 */
export function validateArgs(op, argsObject) {
  const spec = operationFor(op);
  const provided = new Set();
  if (argsObject !== null && argsObject !== undefined) {
    if (typeof argsObject !== "object") {
      throw new TypeError(`validateArgs("${op}", ...) expects an object of arguments`);
    }
    for (const key of Object.keys(argsObject)) {
      if (argsObject[key] !== undefined) provided.add(key);
    }
  }
  const declared = new Set(spec.args.map((a) => a.name));
  const unknown = [...provided].filter((name) => !declared.has(name));
  const absent = spec.args.filter((a) => !provided.has(a.name));
  const missingRequired = absent.filter((a) => !a.nillable).map((a) => a.name);
  const missingNillable = absent.filter((a) => a.nillable).map((a) => a.name);
  return {
    ok: unknown.length === 0 && missingRequired.length === 0,
    unknown,
    missingRequired,
    missingNillable,
  };
}

/**
 * The elements a request body must contain, IN WSDL ORDER, for the given arguments (R17).
 *
 * This exists so the undefined/null contract validateArgs() assumes is enforceable in one
 * testable place instead of being restated in every serialiser: keys whose value is
 * `undefined` are dropped (the server must not see the element), `null` is kept (the element
 * is sent). Unknown names are NOT silently discarded — they are returned in `unknown` so the
 * caller cannot ship a request that the server will quietly shorten into an arity error.
 * Order matters: every request wrapper in this WSDL is an <xsd:sequence>.
 */
export function orderedArgs(op, argsObject) {
  const spec = operationFor(op);
  const source = argsObject == null ? {} : argsObject;
  if (typeof source !== "object") {
    throw new TypeError(`orderedArgs("${op}", ...) expects an object of arguments`);
  }
  const elements = [];
  for (const a of spec.args) {
    if (!Object.prototype.hasOwnProperty.call(source, a.name)) continue;
    const value = source[a.name];
    if (value === undefined) continue;
    elements.push({ name: a.name, type: a.type, nillable: a.nillable, value });
  }
  const declared = new Set(spec.args.map((a) => a.name));
  const unknown = Object.keys(source).filter((k) => source[k] !== undefined && !declared.has(k));
  return { elements, unknown };
}

/**
 * Pre-flight a *_SetFields list against a complexType (R4).
 * Accepts the comma-separated string the API itself takes, or an array of names.
 * An empty token (from "Id,,Files" or a trailing comma) is reported as invalid: it is not a
 * field name, so this refuses locally. Whether the server tolerates an empty token was never
 * probed — no probe in data/probes/ ever sent a doubled or trailing comma — so this is a
 * fail-safe local choice, not a transcribed API fact.
 *
 * The type name is the CALLER's: use SET_FIELDS_TYPE[op] to get the one the WSDL's own
 * documentation binds to that operation. All 178 complexTypes are legal arguments
 * here, including the *Create/*Update inputs and the ArrayOf* wrappers, so a wrong-but-real
 * type name returns ok:true.
 */
export function validateFields(typeName, fieldList) {
  const known = new Set(fieldsFor(typeName));
  let names;
  if (typeof fieldList === "string") {
    names = fieldList.split(",").map((f) => f.trim());
  } else if (Array.isArray(fieldList)) {
    names = fieldList.map((f) => (typeof f === "string" ? f.trim() : f));
  } else {
    throw new TypeError(`validateFields("${typeName}", ...) expects a comma-separated string or an array`);
  }
  const invalid = names.filter((f) => typeof f !== "string" || !known.has(f));
  return { ok: invalid.length === 0, invalid };
}

/** All operation names, in WSDL document order. */
export function operationNames() {
  return Object.keys(OPERATIONS);
}

// The surface is PINNED: freezing makes an accidental runtime mutation throw in strict
// mode (ESM is always strict) instead of quietly corrupting every later call. Pure
// in-module work — no I/O, no globals touched.
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}
deepFreeze(OPERATIONS);
deepFreeze(TYPES);
deepFreeze(TYPE_DETAILS);
deepFreeze(ENUMS);
deepFreeze(SOURCE);
deepFreeze(FIELD_SET_OPERATIONS);
deepFreeze(SET_FIELDS_TYPE);
deepFreeze(FORBIDDEN_OPERATIONS);
